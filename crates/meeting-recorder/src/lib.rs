//! Desktop meeting capture used by the Tauri app.
//!
//! - FFmpeg writes standalone segments plus a PCM feed (see [`ffmpeg`]).
//! - A reader thread feeds the PCM to the Rust activity detector; a control
//!   thread ticks it, watches an optional meeting window, and stops FFmpeg on
//!   a hard signal, prolonged inactivity or the hard limit. It never touches
//!   the network, so Stop always takes effect promptly.
//! - A separate uploader thread sends finished segments. A segment counts as
//!   uploaded only when the server confirms it; until then it stays on disk.
//!   Progress lives in `meeting.json` (atomic rename), so a crash or power
//!   loss resumes where it left off.

pub mod devices;
pub mod ffmpeg;

use cap_meeting_detector::{Config as DetectorConfig, Decision, Detector, Signal, WarnReason};
use cap_meeting_protocol::{
    ids, CaptureMode, CreateMeetingRequest, FinalizeMeetingRequest, MeetingView, StopReason,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Cap server: {0}")]
    Http(String),
    /// Some audio could not be sent yet (offline, server busy); retry later.
    #[error("some audio is still waiting to upload: {0}")]
    Pending(String),
    /// The device credential is expired or belongs to another pairing.
    #[error("Cap needs to be paired again before this meeting can upload")]
    Reauthorize,
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock()
        .map_err(|_| Error::Other("internal lock poisoned".into()))
}

/// What happened to one chunk upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UploadOutcome {
    /// The server has exactly these bytes.
    Acknowledged,
    /// Network error, timeout, 408/429/5xx: try again later.
    Retry(String),
    /// 401, or 404 (the meeting is not visible to this token): the credential
    /// expired or was replaced. Keep the audio until the user pairs again.
    Reauthorize,
    /// The server will never take these bytes for this slot (different bytes
    /// already stored, meeting no longer recording, rejected media). The file
    /// is kept on disk and recorded as quarantined, never deleted.
    Quarantine(String),
}

/// Talks to the Cap server with a client-scoped device token.
#[derive(Clone)]
pub struct Client {
    server: String,
    token: String,
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new(server: &str, token: &str) -> Result<Self> {
        Self::with_timeout(server, token, Duration::from_secs(60))
    }

    pub fn with_timeout(server: &str, token: &str, timeout: Duration) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|e| Error::Http(e.to_string()))?;
        Ok(Self {
            server: server.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http,
        })
    }

    pub fn server(&self) -> &str {
        &self.server
    }

    fn send(&self, req: reqwest::blocking::RequestBuilder) -> Result<(u16, serde_json::Value)> {
        let res = req
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| Error::Http(e.without_url().to_string()))?;
        let status = res.status().as_u16();
        let body = res.text().unwrap_or_default();
        Ok((
            status,
            serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
        ))
    }

    pub fn create_meeting(&self, req: &CreateMeetingRequest) -> Result<MeetingView> {
        let (status, body) = self.send(
            self.http
                .post(format!("{}/v1/meetings", self.server))
                .json(req),
        )?;
        match status {
            200 | 201 => serde_json::from_value(body).map_err(|e| Error::Http(e.to_string())),
            401 => Err(Error::Reauthorize),
            s => Err(Error::Http(format!("creating the meeting returned {s}"))),
        }
    }

    pub fn meeting(&self, id: &str) -> Result<MeetingView> {
        let (status, body) =
            self.send(self.http.get(format!("{}/v1/meetings/{id}", self.server)))?;
        match status {
            200 => serde_json::from_value(body).map_err(|e| Error::Http(e.to_string())),
            401 | 404 => Err(Error::Reauthorize),
            s => Err(Error::Http(format!("reading the meeting returned {s}"))),
        }
    }

    pub fn upload(&self, id: &str, seg: &ffmpeg::Segment, bytes: Vec<u8>) -> UploadOutcome {
        let ext = Path::new(&seg.file)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("ogg");
        let req = self
            .http
            .put(format!(
                "{}/v1/meetings/{id}/chunks/{}",
                self.server, seg.seq
            ))
            .header(
                "content-type",
                if ext == "webm" {
                    "video/webm"
                } else {
                    "audio/ogg"
                },
            )
            .header("x-chunk-sha256", ids::sha256_hex(&bytes))
            .header("x-chunk-start-ms", seg.start_ms.to_string())
            .header(
                "x-chunk-duration-ms",
                (seg.end_ms - seg.start_ms).max(1).to_string(),
            )
            .body(bytes);
        match self.send(req) {
            Err(e) => UploadOutcome::Retry(e.to_string()),
            Ok((status, body)) => classify_upload(status, &body),
        }
    }

    /// Asks the server to let this (re-paired, same-client) credential finish
    /// a meeting whose original credential expired.
    pub fn adopt(&self, id: &str) -> Result<()> {
        let (status, body) = self.send(
            self.http
                .post(format!("{}/v1/meetings/{id}/adopt", self.server)),
        )?;
        match status {
            200 => Ok(()),
            401 | 404 => Err(Error::Reauthorize),
            s => Err(Error::Http(format!(
                "taking over the meeting returned {s} {}",
                body.get("error").and_then(|v| v.as_str()).unwrap_or("")
            ))),
        }
    }

    pub fn finalize(
        &self,
        id: &str,
        req: &FinalizeMeetingRequest,
    ) -> Result<(u16, serde_json::Value)> {
        self.send(
            self.http
                .post(format!("{}/v1/meetings/{id}/finalize", self.server))
                .json(req),
        )
    }
}

/// Maps a chunk upload response to what the device should do with its copy.
pub fn classify_upload(status: u16, body: &serde_json::Value) -> UploadOutcome {
    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
    match status {
        200 | 201 => UploadOutcome::Acknowledged,
        401 | 404 => UploadOutcome::Reauthorize,
        408 | 429 | 500..=599 => UploadOutcome::Retry(format!("server returned {status}")),
        _ => UploadOutcome::Quarantine(
            format!("server returned {status} {error}")
                .trim()
                .to_owned(),
        ),
    }
}

/// On-disk progress for one meeting. Holds no secrets.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Journal {
    pub meeting_id: String,
    pub server: String,
    pub mode: CaptureMode,
    pub uploaded: Vec<u32>,
    /// Segments the server refused for good; kept on disk, never deleted.
    #[serde(default)]
    pub quarantined: Vec<u32>,
    pub stop_reason: Option<StopReason>,
    pub finalized: bool,
}

impl Journal {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("meeting.json")
    }

    pub fn load(dir: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(Self::path(dir))?;
        serde_json::from_str(&text).map_err(|e| Error::Other(format!("meeting.json: {e}")))
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        let tmp = dir.join("meeting.json.tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(self).map_err(|e| Error::Other(e.to_string()))?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, Self::path(dir))?;
        Ok(())
    }
}

/// Result of one upload pass.
#[derive(Debug, Default)]
pub struct SyncReport {
    pub segments: Vec<ffmpeg::Segment>,
    /// A segment is waiting for the network or the server.
    pub pending: Option<String>,
    pub needs_reauthorization: bool,
}

/// Uploads every finished segment not yet confirmed, in order.
pub fn sync_segments(client: &Client, dir: &Path, journal: &Mutex<Journal>) -> Result<SyncReport> {
    let csv = std::fs::read_to_string(dir.join("segments.csv")).unwrap_or_default();
    let mut report = SyncReport {
        segments: ffmpeg::parse_segment_list(&csv),
        ..SyncReport::default()
    };
    let id = lock(journal)?.meeting_id.clone();
    for seg in &report.segments {
        {
            let j = lock(journal)?;
            if j.uploaded.contains(&seg.seq) || j.quarantined.contains(&seg.seq) {
                continue;
            }
        }
        let bytes = std::fs::read(dir.join(&seg.file))?;
        match client.upload(&id, seg, bytes) {
            UploadOutcome::Acknowledged => {
                let mut j = lock(journal)?;
                j.uploaded.push(seg.seq);
                j.save(dir)?;
            }
            UploadOutcome::Quarantine(why) => {
                let mut j = lock(journal)?;
                j.quarantined.push(seg.seq);
                j.save(dir)?;
                eprintln!("cap: segment {} quarantined: {why}", seg.seq);
            }
            UploadOutcome::Retry(why) => {
                report.pending = Some(why);
                break;
            }
            UploadOutcome::Reauthorize => {
                report.needs_reauthorization = true;
                break;
            }
        }
    }
    Ok(report)
}

/// Finalizes the meeting once every segment on disk is either confirmed or
/// quarantined. Gaps are accepted only for audio that no longer exists
/// locally or was quarantined; audio that is merely waiting to upload blocks
/// finalizing, because the server refuses chunks after finalize.
pub fn finalize(
    client: &Client,
    dir: &Path,
    journal: &Mutex<Journal>,
    reason: StopReason,
) -> Result<()> {
    let report = sync_segments(client, dir, journal)?;
    if report.needs_reauthorization {
        return Err(Error::Reauthorize);
    }
    if let Some(why) = report.pending {
        return Err(Error::Pending(why));
    }
    let Some(last) = report.segments.iter().map(|s| s.seq).max() else {
        return Err(Error::Other("nothing was recorded".into()));
    };
    let id = lock(journal)?.meeting_id.clone();
    let mut req = FinalizeMeetingRequest {
        last_seq: last,
        stop_reason: reason,
        ended_at: chrono::Utc::now(),
        allow_missing: false,
    };
    let (mut status, body) = client.finalize(&id, &req)?;
    if status == 409 && body.get("error").and_then(|v| v.as_str()) == Some("missing_chunks") {
        let missing: Vec<u32> = body
            .get("missing_chunks")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let j = lock(journal)?.clone();
        let listed: std::collections::HashMap<u32, &ffmpeg::Segment> =
            report.segments.iter().map(|s| (s.seq, s)).collect();
        // Only accept a gap if that audio is gone or the server refused it.
        let recoverable: Vec<u32> = missing
            .into_iter()
            .filter(|seq| {
                !j.quarantined.contains(seq)
                    && listed.get(seq).is_some_and(|s| dir.join(&s.file).is_file())
            })
            .collect();
        if !recoverable.is_empty() {
            return Err(Error::Pending(format!(
                "segments {recoverable:?} are on disk but not on the server"
            )));
        }
        req.allow_missing = true;
        status = client.finalize(&id, &req)?.0;
    }
    match status {
        202 => {
            let mut j = lock(journal)?;
            j.finalized = true;
            j.stop_reason = Some(reason);
            j.save(dir)
        }
        401 | 404 => Err(Error::Reauthorize),
        s => Err(Error::Http(format!("finalize returned {s}"))),
    }
}

/// A meeting [`recover_all`] finished, and the credential that finished it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovered {
    pub meeting_id: String,
    pub token: String,
}

/// Resumes meetings left unfinished by a crash, an outage or an expired
/// credential: uploads what is on disk and finalizes it with its recorded
/// stop reason (or `interrupted`).
///
/// `tokens_for` lists credentials to try for a meeting, its own first. If
/// the meeting's own credential is refused (expired, revoked), a later one
/// from a re-pairing for the same client asks the server to take the meeting
/// over first; the server only allows that for the same tenant and client.
pub fn recover_all(root: &Path, tokens_for: impl Fn(&Journal) -> Vec<String>) -> Vec<Recovered> {
    let mut done = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return done;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(j) = Journal::load(&dir) else { continue };
        if j.finalized {
            continue;
        }
        let reason = j.stop_reason.unwrap_or(StopReason::Interrupted);
        let id = j.meeting_id.clone();
        let server = j.server.clone();
        let tokens = tokens_for(&j);
        let journal = Mutex::new(j);
        for (n, token) in tokens.iter().enumerate() {
            let Ok(client) = Client::new(&server, token) else {
                break;
            };
            if n > 0 && client.adopt(&id).is_err() {
                continue;
            }
            match finalize(&client, &dir, &journal, reason) {
                Ok(()) => {
                    done.push(Recovered {
                        meeting_id: id.clone(),
                        token: token.clone(),
                    });
                    break;
                }
                Err(Error::Reauthorize) => continue,
                // Offline or server busy: leave it for the next attempt.
                Err(_) => break,
            }
        }
    }
    done
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Warning {
        reason: &'static str,
        stops_in_ms: u64,
    },
    Stopped {
        reason: StopReason,
    },
    Finalized {
        meeting_id: String,
    },
    /// Uploading could not finish; the audio stays on disk and is retried on
    /// the next launch. `reauthorize` means the user must pair again.
    Failed {
        message: String,
        reauthorize: bool,
    },
}

pub struct StartOptions {
    pub client: Client,
    pub dir: PathBuf,
    pub ffmpeg: String,
    pub inputs: Vec<ffmpeg::Input>,
    pub title: String,
    pub mode: CaptureMode,
    /// Segment length; [`ffmpeg::SEGMENT_SECONDS`] outside tests.
    pub segment_seconds: u32,
    pub detector: DetectorConfig,
    /// Returns false once the watched meeting window is gone.
    pub watch_window: Option<Box<dyn Fn() -> bool + Send>>,
    pub on_event: Arc<dyn Fn(Event) + Send + Sync>,
    /// How often the uploader looks for finished segments.
    pub upload_interval: Duration,
}

pub struct Session {
    pub meeting_id: String,
    control: mpsc::Sender<Signal>,
    capture: Option<JoinHandle<()>>,
    uploader: Option<JoinHandle<()>>,
}

impl Session {
    pub fn start(opts: StartOptions) -> Result<Self> {
        std::fs::create_dir_all(&opts.dir)?;
        let meeting = opts.client.create_meeting(&CreateMeetingRequest {
            title: opts.title.chars().take(200).collect(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            started_at: chrono::Utc::now(),
            capture_mode: opts.mode,
            provider_hint: None,
            meeting_url: None,
        })?;
        let journal = Arc::new(Mutex::new(Journal {
            meeting_id: meeting.id.clone(),
            server: opts.client.server.clone(),
            mode: opts.mode,
            uploaded: Vec::new(),
            quarantined: Vec::new(),
            stop_reason: None,
            finalized: false,
        }));
        lock(&journal)?.save(&opts.dir)?;

        let mut child = Command::new(&opts.ffmpeg)
            .args(ffmpeg::args(
                &opts.inputs,
                opts.mode,
                &opts.dir,
                opts.segment_seconds,
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Other(format!("could not start FFmpeg: {e}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("ffmpeg stdout".into()))?;
        let stdin = child.stdin.take();

        let detector = Arc::new(Mutex::new(Detector::new(opts.detector, 0)));
        let clock = Instant::now();
        let pcm_alive = Arc::new(AtomicBool::new(true));
        {
            let detector = detector.clone();
            let alive = pcm_alive.clone();
            std::thread::spawn(move || pcm_reader(stdout, detector, clock, alive));
        }
        let capture_done = Arc::new(AtomicBool::new(false));
        let stop_reason = Arc::new(Mutex::new(None::<StopReason>));

        let uploader = {
            let client = opts.client.clone();
            let dir = opts.dir.clone();
            let journal = journal.clone();
            let done = capture_done.clone();
            let reason = stop_reason.clone();
            let on_event = opts.on_event.clone();
            let interval = opts.upload_interval;
            std::thread::spawn(move || {
                uploader_loop(client, dir, journal, done, reason, on_event, interval)
            })
        };

        let (tx, rx) = mpsc::channel();
        let capture = std::thread::spawn(move || {
            control_loop(ControlCtx {
                rx,
                child,
                stdin,
                detector,
                clock,
                pcm_alive,
                journal,
                dir: opts.dir,
                watch: opts.watch_window,
                on_event: opts.on_event,
                capture_done,
                stop_reason,
            })
        });
        Ok(Self {
            meeting_id: meeting.id,
            control: tx,
            capture: Some(capture),
            uploader: Some(uploader),
        })
    }

    pub fn signal(&self, s: Signal) {
        let _ = self.control.send(s);
    }

    /// Stops recording and returns once FFmpeg has closed the last segment.
    /// Uploading and finalizing continue in the background and report
    /// through `on_event`.
    pub fn stop(&mut self) {
        self.signal(Signal::UserStop);
        if let Some(c) = self.capture.take() {
            let _ = c.join();
        }
    }

    /// Whether audio is still being captured.
    pub fn is_running(&self) -> bool {
        self.capture.as_ref().is_some_and(|c| !c.is_finished())
    }

    /// Waits up to `timeout` for uploading and finalizing to finish.
    pub fn wait_uploaded(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.uploader.as_ref().is_none_or(|u| u.is_finished()) {
                if let Some(u) = self.uploader.take() {
                    let _ = u.join();
                }
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }
}

fn pcm_reader(
    mut out: impl Read,
    detector: Arc<Mutex<Detector>>,
    clock: Instant,
    alive: Arc<AtomicBool>,
) {
    // 100 ms frames of s16le mono.
    let mut buf = vec![0u8; (ffmpeg::PCM_RATE as usize / 10) * 2];
    while out.read_exact(&mut buf).is_ok() {
        let mut sum = 0f64;
        for pair in buf.chunks_exact(2) {
            let v = f64::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0;
            sum += v * v;
        }
        let rms = (sum / (buf.len() / 2) as f64).sqrt() as f32;
        if let Ok(mut d) = detector.lock() {
            d.feed_rms(clock.elapsed().as_millis() as u64, rms);
        }
    }
    alive.store(false, Ordering::SeqCst);
}

fn uploader_loop(
    client: Client,
    dir: PathBuf,
    journal: Arc<Mutex<Journal>>,
    capture_done: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<StopReason>>>,
    on_event: Arc<dyn Fn(Event) + Send + Sync>,
    interval: Duration,
) {
    while !capture_done.load(Ordering::SeqCst) {
        let _ = sync_segments(&client, &dir, &journal);
        let deadline = Instant::now() + interval;
        while Instant::now() < deadline && !capture_done.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let reason = stop_reason
        .lock()
        .ok()
        .and_then(|r| *r)
        .unwrap_or(StopReason::Interrupted);
    let mut last_error = Error::Other("not attempted".into());
    for attempt in 0..6u32 {
        match finalize(&client, &dir, &journal, reason) {
            Ok(()) => {
                let id = journal
                    .lock()
                    .map(|j| j.meeting_id.clone())
                    .unwrap_or_default();
                on_event(Event::Finalized { meeting_id: id });
                return;
            }
            Err(Error::Reauthorize) => {
                last_error = Error::Reauthorize;
                break;
            }
            Err(e) => last_error = e,
        }
        std::thread::sleep(interval.saturating_mul(1 << attempt.min(4)));
    }
    on_event(Event::Failed {
        reauthorize: matches!(last_error, Error::Reauthorize),
        message: last_error.to_string(),
    });
}

struct ControlCtx {
    rx: mpsc::Receiver<Signal>,
    child: Child,
    stdin: Option<ChildStdin>,
    detector: Arc<Mutex<Detector>>,
    clock: Instant,
    pcm_alive: Arc<AtomicBool>,
    journal: Arc<Mutex<Journal>>,
    dir: PathBuf,
    watch: Option<Box<dyn Fn() -> bool + Send>>,
    on_event: Arc<dyn Fn(Event) + Send + Sync>,
    capture_done: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<StopReason>>>,
}

fn control_loop(mut c: ControlCtx) {
    let mut last_watch = Instant::now();
    let mut last_warn: Option<Instant> = None;
    let reason = loop {
        let now = c.clock.elapsed().as_millis() as u64;
        while let Ok(sig) = c.rx.try_recv() {
            if let Ok(mut d) = c.detector.lock() {
                d.signal(now, sig);
            }
        }
        if let Some(watch) = &c.watch {
            if last_watch.elapsed() > Duration::from_secs(5) {
                last_watch = Instant::now();
                if !watch() {
                    if let Ok(mut d) = c.detector.lock() {
                        d.signal(now, Signal::WindowClosed);
                    }
                }
            }
        }
        let decision = c
            .detector
            .lock()
            .map(|mut d| d.tick(now))
            .unwrap_or(Decision::Continue);
        if let Decision::Stop { reason } = decision {
            break map_reason(reason);
        }
        if !c.pcm_alive.load(Ordering::SeqCst) {
            // FFmpeg exited on its own: the device went away or it crashed.
            break StopReason::DeviceLost;
        }
        match decision {
            Decision::Warn { reason, stop_at_ms } => {
                if last_warn.is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
                    last_warn = Some(Instant::now());
                    (c.on_event)(Event::Warning {
                        reason: match reason {
                            WarnReason::Inactivity => "inactivity",
                            WarnReason::HardLimitApproaching => "hard_limit",
                            WarnReason::SoftSignal(_) => "signal",
                        },
                        stops_in_ms: stop_at_ms.saturating_sub(now),
                    });
                }
            }
            _ => last_warn = None,
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    if let Ok(mut r) = c.stop_reason.lock() {
        *r = Some(reason);
    }
    if let Ok(mut j) = c.journal.lock() {
        j.stop_reason = Some(reason);
        let _ = j.save(&c.dir);
    }
    // Ask FFmpeg to finish cleanly so the last segment is closed and listed.
    if let Some(mut stdin) = c.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if matches!(c.child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if matches!(c.child.try_wait(), Ok(None)) {
        let _ = c.child.kill();
        let _ = c.child.wait();
    }
    (c.on_event)(Event::Stopped { reason });
    c.capture_done.store(true, Ordering::SeqCst);
}

fn map_reason(r: cap_meeting_detector::StopReason) -> StopReason {
    use cap_meeting_detector::StopReason as D;
    match r {
        D::UserStopped => StopReason::UserStopped,
        D::MeetingEnded => StopReason::MeetingEnded,
        D::TabClosed => StopReason::TabClosed,
        D::WindowClosed => StopReason::WindowClosed,
        D::DeviceLost => StopReason::DeviceLost,
        D::ProlongedInactivity => StopReason::ProlongedInactivity,
        D::HardLimit => StopReason::HardLimit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_confirmed_uploads_count_as_acknowledged() {
        assert_eq!(
            classify_upload(201, &json!({})),
            UploadOutcome::Acknowledged
        );
        assert_eq!(
            classify_upload(200, &json!({"status": "duplicate"})),
            UploadOutcome::Acknowledged
        );
        assert_eq!(classify_upload(401, &json!({})), UploadOutcome::Reauthorize);
        assert_eq!(
            classify_upload(404, &json!({"error": "meeting_not_found"})),
            UploadOutcome::Reauthorize
        );
        for s in [408, 429, 500, 503] {
            assert!(matches!(
                classify_upload(s, &json!({})),
                UploadOutcome::Retry(_)
            ));
        }
        for s in [409, 413, 415, 400] {
            assert!(matches!(
                classify_upload(s, &json!({"error": "x"})),
                UploadOutcome::Quarantine(_)
            ));
        }
    }
}
