//! Minimal Chrome DevTools Protocol client over a local WebSocket. Chrome
//! listens on 127.0.0.1 only, inside the runner's own sandbox; nothing here
//! hides automation or alters what the page can see about the browser.

use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

#[derive(Debug, thiserror::Error)]
pub enum CdpError {
    #[error("browser: {0}")]
    Browser(String),
    #[error("browser protocol error in {method}: {message}")]
    Protocol { method: String, message: String },
    #[error("browser did not answer {0} in time")]
    Timeout(String),
}

pub type Result<T> = std::result::Result<T, CdpError>;

fn err(e: impl std::fmt::Display) -> CdpError {
    CdpError::Browser(e.to_string())
}

pub struct Cdp {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next: u64,
    net: NetStats,
    /// Domain bucket of each request still in flight (bounded).
    pending: HashMap<String, &'static str>,
}

const MAX_PENDING: usize = 5_000;

/// Domains a blocked request is reported under; anything else is "other".
/// Only these names (never URLs) leave the bot.
pub const KNOWN_DOMAINS: &[&str] = &[
    "google.com",
    "gstatic.com",
    "googleapis.com",
    "googleusercontent.com",
    "ggpht.com",
    "gvt1.com",
    "gvt2.com",
    "youtube.com",
    "ytimg.com",
    "googlevideo.com",
    "doubleclick.net",
    "google-analytics.com",
    "googletagmanager.com",
    "googlesyndication.com",
    "recaptcha.net",
    "withgoogle.com",
];

/// Failed page requests, counted from the browser's own network log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetStats {
    /// Requests the browser refused to make (URL policy), by domain bucket.
    pub blocked: BTreeMap<&'static str, u32>,
    /// Other network failures, by Chrome's own error code (`ERR_…`,
    /// a fixed vocabulary; anything else is "ERR_OTHER").
    pub errors: BTreeMap<String, u32>,
}

fn domain_bucket(url: &str) -> &'static str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    KNOWN_DOMAINS
        .iter()
        .copied()
        .find(|d| host == *d || host.ends_with(&format!(".{d}")))
        .unwrap_or("other")
}

impl NetStats {
    /// `failed` is a `Network.loadingFailed` event's params. Production
    /// Chrome blocks by URL policy (ERR_BLOCKED_BY_ADMINISTRATOR); tests
    /// block through DevTools (blockedReason "inspector"). Cancelled and
    /// aborted requests are normal page behaviour and not counted.
    fn record_failure(&mut self, failed: &Value, bucket: &'static str) {
        let text = failed
            .get("errorText")
            .and_then(Value::as_str)
            .unwrap_or("");
        let reason = failed.get("blockedReason").and_then(Value::as_str);
        if text.contains("ERR_BLOCKED_BY_ADMINISTRATOR") || reason == Some("inspector") {
            let n = self.blocked.entry(bucket).or_insert(0);
            *n = n.saturating_add(1);
        } else if failed.get("canceled").and_then(Value::as_bool) != Some(true)
            && !text.contains("ERR_ABORTED")
            && (reason.is_some() || !text.is_empty())
        {
            let code = text.strip_prefix("net::").unwrap_or("");
            let code = if code.len() <= 40
                && code.starts_with("ERR_")
                && code.bytes().all(|c| c.is_ascii_uppercase() || c == b'_')
            {
                code.to_owned()
            } else {
                "ERR_OTHER".to_owned()
            };
            if self.errors.len() < 8 || self.errors.contains_key(&code) {
                let n = self.errors.entry(code).or_insert(0);
                *n = n.saturating_add(1);
            }
        }
    }
}

impl Cdp {
    /// Keeps only per-request domain buckets and failure counts.
    fn event(&mut self, method: &str, p: &Value) {
        let id = p.get("requestId").and_then(Value::as_str);
        match (method, id) {
            ("Network.requestWillBeSent", Some(id)) if self.pending.len() < MAX_PENDING => {
                let url = p["request"]["url"].as_str().unwrap_or("");
                self.pending.insert(id.to_owned(), domain_bucket(url));
            }
            ("Network.loadingFinished", Some(id)) => {
                self.pending.remove(id);
            }
            ("Network.loadingFailed", Some(id)) => {
                let bucket = self.pending.remove(id).unwrap_or("other");
                self.net.record_failure(p, bucket);
            }
            _ => {}
        }
    }

    pub fn connect(url: &str) -> Result<Self> {
        let (ws, _) = tungstenite::connect(url).map_err(err)?;
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            s.set_read_timeout(Some(Duration::from_millis(500)))
                .map_err(err)?;
        }
        Ok(Self {
            ws,
            next: 1,
            net: NetStats::default(),
            pending: HashMap::new(),
        })
    }

    /// Sends one command and waits for its answer, skipping events.
    pub fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        let id = self.next;
        self.next += 1;
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        self.ws.send(Message::text(msg.to_string())).map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() > deadline {
                return Err(CdpError::Timeout(method.into()));
            }
            let m = match self.ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(err(e)),
            };
            let Message::Text(text) = m else { continue };
            let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if let Some(m) = v.get("method").and_then(Value::as_str) {
                self.event(m, &v["params"]);
                continue;
            }
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                return Err(CdpError::Protocol {
                    method: method.into(),
                    message: e
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect(),
                });
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_requests_are_bucketed_without_urls() {
        let mut c = NetStats::default();
        let admin = json!({"errorText": "net::ERR_BLOCKED_BY_ADMINISTRATOR", "canceled": false});
        for url in [
            "https://lh3.googleusercontent.com/a/x?sz=64",
            "https://user:pw@www.gstatic.com:443/x.js",
            "https://evil.example/secret-token",
            "https://notgoogle.com.evil/x",
        ] {
            c.record_failure(&admin, domain_bucket(url));
        }
        c.record_failure(
            &json!({"errorText": "", "blockedReason": "inspector"}),
            "other",
        );
        c.record_failure(
            &json!({"errorText": "net::ERR_CONNECTION_RESET", "canceled": false}),
            "google.com",
        );
        c.record_failure(
            &json!({"errorText": "net::ERR_<b>x", "canceled": false}),
            "google.com",
        );
        c.record_failure(
            &json!({"errorText": "net::ERR_ABORTED", "canceled": false}),
            "google.com",
        );
        c.record_failure(
            &json!({"errorText": "net::ERR_FAILED", "canceled": true}),
            "google.com",
        );
        let want: BTreeMap<&str, u32> = [
            ("googleusercontent.com", 1),
            ("gstatic.com", 1),
            ("other", 3),
        ]
        .into();
        assert_eq!(c.blocked, want);
        let errs: BTreeMap<String, u32> = [
            ("ERR_CONNECTION_RESET".to_owned(), 1),
            ("ERR_OTHER".to_owned(), 1),
        ]
        .into();
        assert_eq!(c.errors, errs);
    }
}

#[derive(Clone)]
pub struct Killer(Arc<Mutex<Child>>);

impl Killer {
    pub fn kill(&self) {
        if let Ok(mut c) = self.0.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// A private Chrome with one page, deleted (profile included) on drop.
pub struct Browser {
    child: Arc<Mutex<Child>>,
    profile: PathBuf,
    cdp: Cdp,
    session: String,
}

pub struct LaunchOptions<'a> {
    pub chrome: &'a str,
    pub profile: PathBuf,
    /// PulseAudio sink that receives the meeting audio.
    pub pulse_sink: &'a str,
    /// Microphone source; `None` uses the default (silent for the notetaker).
    pub pulse_source: Option<&'a str>,
    /// Only for container runtimes without user namespaces.
    pub no_sandbox: bool,
    /// Tests on a workstation: no window.
    pub headless: bool,
}

impl Browser {
    pub fn launch(o: LaunchOptions<'_>) -> Result<Self> {
        let _ = std::fs::remove_dir_all(&o.profile);
        std::fs::create_dir_all(&o.profile).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&o.profile, std::fs::Permissions::from_mode(0o700))
                .map_err(err)?;
        }
        let mut cmd = Command::new(o.chrome);
        cmd.arg(format!("--user-data-dir={}", o.profile.display()))
            .args([
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--disable-extensions",
                "--lang=en-US",
                "--accept-lang=en-US,en",
                // Meeting audio must play without a user gesture.
                "--autoplay-policy=no-user-gesture-required",
                // Answer the camera/microphone prompt; the bot's microphone
                // is a silent virtual device and both are switched off.
                "--use-fake-ui-for-media-stream",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--window-size=1280,720",
                "about:blank",
            ])
            // Only what Chrome needs; never the runner token.
            .env_clear()
            .envs(
                ["PATH", "HOME", "DISPLAY", "XDG_RUNTIME_DIR", "LANG", "TZ"]
                    .iter()
                    .filter_map(|k| std::env::var(k).ok().map(|v| (*k, v))),
            )
            .env("PULSE_SINK", o.pulse_sink)
            .envs(o.pulse_source.map(|s| ("PULSE_SOURCE", s.to_owned())))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if o.no_sandbox {
            cmd.arg("--no-sandbox");
        }
        if o.headless {
            cmd.arg("--headless=new");
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| CdpError::Browser(format!("could not start Chrome: {e}")))?;
        let port_file = o.profile.join("DevToolsActivePort");
        let deadline = Instant::now() + Duration::from_secs(30);
        let endpoint = loop {
            if let Ok(text) = std::fs::read_to_string(&port_file) {
                let mut lines = text.lines();
                if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                    if let Ok(port) = port.trim().parse::<u16>() {
                        break format!("ws://127.0.0.1:{port}{}", path.trim());
                    }
                }
            }
            if matches!(child.try_wait(), Ok(Some(_))) || Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CdpError::Browser("Chrome did not start".into()));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let mut cdp = match Cdp::connect(&endpoint) {
            Ok(c) => c,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        let target = cdp.call(None, "Target.createTarget", json!({"url": "about:blank"}))?;
        let target_id = target["targetId"]
            .as_str()
            .ok_or_else(|| err("no target"))?
            .to_owned();
        let attached = cdp.call(
            None,
            "Target.attachToTarget",
            json!({"targetId": target_id, "flatten": true}),
        )?;
        let session = attached["sessionId"]
            .as_str()
            .ok_or_else(|| err("no session"))?
            .to_owned();
        cdp.call(Some(&session), "Page.enable", json!({}))?;
        cdp.call(Some(&session), "Runtime.enable", json!({}))?;
        // Failed requests (including URL-policy blocks) are counted by
        // domain bucket; no URL is kept once a request settles.
        cdp.call(Some(&session), "Network.enable", json!({}))?;
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            profile: o.profile,
            cdp,
            session,
        })
    }

    pub fn navigate(&mut self, url: &str) -> Result<()> {
        let r = self.cdp.call(
            Some(&self.session.clone()),
            "Page.navigate",
            json!({"url": url}),
        )?;
        if let Some(e) = r.get("errorText").and_then(Value::as_str) {
            return Err(CdpError::Browser(format!("navigation failed: {e}")));
        }
        Ok(())
    }

    /// Evaluates an expression in the page and returns its JSON value.
    pub fn eval(&mut self, expression: &str) -> Result<Value> {
        let session = self.session.clone();
        let r = self.cdp.call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
        )?;
        if r.get("exceptionDetails").is_some() {
            return Err(CdpError::Protocol {
                method: "Runtime.evaluate".into(),
                message: "page script failed".into(),
            });
        }
        Ok(r["result"].get("value").cloned().unwrap_or(Value::Null))
    }

    /// Any page-scoped DevTools command (tests use it to set cookies).
    pub fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        let session = self.session.clone();
        self.cdp.call(Some(&session), method, params)
    }

    /// A real (trusted) mouse click at page coordinates.
    pub fn click(&mut self, x: f64, y: f64) -> Result<()> {
        let session = self.session.clone();
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            self.cdp.call(
                Some(&session),
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
            )?;
        }
        Ok(())
    }

    /// Types text into the focused element, as a keyboard would.
    pub fn insert_text(&mut self, text: &str) -> Result<()> {
        let session = self.session.clone();
        self.cdp
            .call(Some(&session), "Input.insertText", json!({"text": text}))?;
        Ok(())
    }

    /// Failed requests seen so far on this page (safe summary).
    pub fn net(&self) -> NetStats {
        self.cdp.net.clone()
    }

    pub fn is_alive(&mut self) -> bool {
        self.child
            .lock()
            .map(|mut c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false)
    }

    /// A handle another thread can use to end the browser (and with it the
    /// meeting audio) immediately, whatever this thread is doing.
    pub fn killer(&self) -> Killer {
        Killer(self.child.clone())
    }

    pub fn profile(&self) -> &Path {
        &self.profile
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.cdp.call(None, "Browser.close", json!({}));
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && self.is_alive() {
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
        // Cookies and site data from the meeting never outlive it.
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}
