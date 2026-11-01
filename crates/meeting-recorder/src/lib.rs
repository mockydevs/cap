//! Desktop meeting capture used by the Tauri app.
//!
//! - FFmpeg writes standalone segments plus a PCM feed (see [`ffmpeg`]).
//! - A reader thread feeds the PCM to the Rust activity detector; a control
//!   thread ticks it, watches an optional meeting window, and stops on a hard
//!   signal, prolonged inactivity or the hard limit.
//! - An uploader sends each finished segment, recording progress in
//!   `meeting.json` (atomic rename), so an app crash or power loss resumes
//!   where it left off and finalizes what was captured as `interrupted`.

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
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Talks to the Cap server with a client-scoped device token.
#[derive(Clone)]
pub struct Client {
    server: String,
    token: String,
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new(server: &str, token: &str) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| Error::Http(e.to_string()))?;
        Ok(Self {
            server: server.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http,
        })
    }

    fn send<T: serde::de::DeserializeOwned>(
        &self,
        req: reqwest::blocking::RequestBuilder,
    ) -> Result<(u16, Option<T>)> {
        let res = req
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| Error::Http(e.without_url().to_string()))?;
        let status = res.status().as_u16();
        let body = res.text().unwrap_or_default();
        Ok((status, serde_json::from_str(&body).ok()))
    }

    pub fn create_meeting(&self, req: &CreateMeetingRequest) -> Result<MeetingView> {
        match self.send(
            self.http
                .post(format!("{}/v1/meetings", self.server))
                .json(req),
        )? {
            (200 | 201, Some(v)) => Ok(v),
            (s, _) => Err(Error::Http(format!("creating the meeting returned {s}"))),
        }
    }

    pub fn meeting(&self, id: &str) -> Result<MeetingView> {
        match self.send(self.http.get(format!("{}/v1/meetings/{id}", self.server)))? {
            (200, Some(v)) => Ok(v),
            (s, _) => Err(Error::Http(format!("reading the meeting returned {s}"))),
        }
    }

    /// Ok(true) when the server has the chunk (stored now or before).
    pub fn upload(&self, id: &str, seg: &ffmpeg::Segment, bytes: Vec<u8>) -> Result<bool> {
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
        let (status, _) = self.send::<serde_json::Value>(req)?;
        Ok(match status {
            200 | 201 => true,
            408 | 429 | 500..=599 => false,
            // Rejected for good (conflict, not recording, bad media): retrying
            // cannot help, so it counts as done and is reported as missing.
            _ => true,
        })
    }

    pub fn finalize(&self, id: &str, req: &FinalizeMeetingRequest) -> Result<u16> {
        let (status, _) = self.send::<serde_json::Value>(
            self.http
                .post(format!("{}/v1/meetings/{id}/finalize", self.server))
                .json(req),
        )?;
        Ok(status)
    }
}

/// On-disk progress for one meeting.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Journal {
    pub meeting_id: String,
    pub server: String,
    pub mode: CaptureMode,
    pub uploaded: Vec<u32>,
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

/// Uploads every finished segment not yet uploaded. Returns the segments
/// FFmpeg has listed so far.
pub fn sync_segments(
    client: &Client,
    dir: &Path,
    journal: &Mutex<Journal>,
) -> Result<Vec<ffmpeg::Segment>> {
    let csv = std::fs::read_to_string(dir.join("segments.csv")).unwrap_or_default();
    let segments = ffmpeg::parse_segment_list(&csv);
    let id = journal
        .lock()
        .map_err(|_| Error::Other("journal lock".into()))?
        .meeting_id
        .clone();
    for seg in &segments {
        let done = journal
            .lock()
            .map_err(|_| Error::Other("journal lock".into()))?
            .uploaded
            .contains(&seg.seq);
        if done {
            continue;
        }
        let bytes = std::fs::read(dir.join(&seg.file))?;
        if !client.upload(&id, seg, bytes)? {
            break; // server busy or offline: try again on the next pass
        }
        let mut j = journal
            .lock()
            .map_err(|_| Error::Other("journal lock".into()))?;
        j.uploaded.push(seg.seq);
        j.save(dir)?;
    }
    Ok(segments)
}

/// Finalizes once everything that can be uploaded is uploaded. Gaps are
/// accepted (and reported as `partial`) only when `allow_missing`.
pub fn finalize(
    client: &Client,
    dir: &Path,
    journal: &Mutex<Journal>,
    reason: StopReason,
    allow_missing: bool,
) -> Result<()> {
    let segments = sync_segments(client, dir, journal)?;
    let Some(last) = segments.iter().map(|s| s.seq).max() else {
        return Err(Error::Other("nothing was recorded".into()));
    };
    let id = journal
        .lock()
        .map_err(|_| Error::Other("journal lock".into()))?
        .meeting_id
        .clone();
    let req = FinalizeMeetingRequest {
        last_seq: last,
        stop_reason: reason,
        ended_at: chrono::Utc::now(),
        allow_missing,
    };
    match client.finalize(&id, &req)? {
        202 => {
            let mut j = journal
                .lock()
                .map_err(|_| Error::Other("journal lock".into()))?;
            j.finalized = true;
            j.stop_reason = Some(reason);
            j.save(dir)
        }
        409 if !allow_missing => finalize(client, dir, journal, reason, true),
        s => Err(Error::Http(format!("finalize returned {s}"))),
    }
}

/// Resumes meetings left unfinished by a crash: uploads what is on disk and
/// finalizes it as `interrupted`. Returns the meeting ids it finished.
pub fn recover_all(root: &Path, token_for: impl Fn(&str) -> Option<String>) -> Vec<String> {
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
        let Some(token) = token_for(&j.server) else {
            continue;
        };
        let Ok(client) = Client::new(&j.server, &token) else {
            continue;
        };
        let reason = j.stop_reason.unwrap_or(StopReason::Interrupted);
        let id = j.meeting_id.clone();
        let journal = Mutex::new(j);
        if finalize(&client, &dir, &journal, reason, true).is_ok() {
            done.push(id);
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
    Failed {
        message: String,
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
    /// Stop when no window with this title exists any more.
    pub watch_window: Option<Box<dyn Fn() -> bool + Send>>,
    pub on_event: Box<dyn Fn(Event) + Send + Sync>,
}

pub struct Session {
    pub meeting_id: String,
    control: mpsc::Sender<Signal>,
    worker: Option<JoinHandle<()>>,
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
            stop_reason: None,
            finalized: false,
        }));
        journal
            .lock()
            .map_err(|_| Error::Other("journal lock".into()))?
            .save(&opts.dir)?;

        let mut child = Command::new(&opts.ffmpeg)
            .args(ffmpeg::args(
                &opts.inputs,
                opts.mode,
                &opts.dir,
                opts.segment_seconds,
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
        let (tx, rx) = mpsc::channel();
        let id = meeting.id.clone();
        let worker = std::thread::spawn(move || {
            control_loop(ControlCtx {
                rx,
                child,
                stdin,
                detector,
                clock,
                pcm_alive,
                journal,
                client: opts.client,
                dir: opts.dir,
                watch: opts.watch_window,
                on_event: opts.on_event,
            })
        });
        Ok(Self {
            meeting_id: id,
            control: tx,
            worker: Some(worker),
        })
    }

    pub fn signal(&self, s: Signal) {
        let _ = self.control.send(s);
    }

    /// Stops (if still running) and waits for the final upload.
    pub fn stop(mut self) {
        self.signal(Signal::UserStop);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }

    pub fn is_running(&self) -> bool {
        self.worker.as_ref().is_some_and(|w| !w.is_finished())
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

struct ControlCtx {
    rx: mpsc::Receiver<Signal>,
    child: Child,
    stdin: Option<ChildStdin>,
    detector: Arc<Mutex<Detector>>,
    clock: Instant,
    pcm_alive: Arc<AtomicBool>,
    journal: Arc<Mutex<Journal>>,
    client: Client,
    dir: PathBuf,
    watch: Option<Box<dyn Fn() -> bool + Send>>,
    on_event: Box<dyn Fn(Event) + Send + Sync>,
}

fn control_loop(mut c: ControlCtx) {
    let mut last_sync = Instant::now();
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
        if !c.pcm_alive.load(Ordering::SeqCst) {
            // FFmpeg exited on its own: the device went away or it crashed.
            break StopReason::DeviceLost;
        }
        let decision = c
            .detector
            .lock()
            .map(|mut d| d.tick(now))
            .unwrap_or(Decision::Continue);
        match decision {
            Decision::Stop { reason } => break map_reason(reason),
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
            Decision::Continue => last_warn = None,
        }
        if last_sync.elapsed() > Duration::from_secs(5) {
            last_sync = Instant::now();
            let _ = sync_segments(&c.client, &c.dir, &c.journal);
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    (c.on_event)(Event::Stopped { reason });
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
    let mut result = Err(Error::Other("not attempted".into()));
    for attempt in 0..6 {
        result = finalize(&c.client, &c.dir, &c.journal, reason, false);
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_secs(5 << attempt.min(3)));
    }
    match result {
        Ok(()) => {
            let id = c
                .journal
                .lock()
                .map(|j| j.meeting_id.clone())
                .unwrap_or_default();
            (c.on_event)(Event::Finalized { meeting_id: id });
        }
        // Left on disk; `recover_all` finishes it on the next launch.
        Err(e) => (c.on_event)(Event::Failed {
            message: e.to_string(),
        }),
    }
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
