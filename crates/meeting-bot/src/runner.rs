//! One attendance at a time: claim → join → record → leave → report.
//!
//! The runner holds only its own runner token. Each claim brings a Meet code
//! and a one-meeting device token; audio goes up through the same upload API
//! and recorder the desktop app uses, so transcription and the signed Calari
//! delivery are unchanged. A heartbeat keeps the lease; when the server says
//! stop (cancelled, hard stop) or the lease is lost, the bot leaves.

use crate::{cdp, meet};
use cap_meeting_detector::Config as DetectorConfig;
use cap_meeting_protocol::CaptureMode;
use cap_meeting_recorder as recorder;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Config {
    pub server: String,
    pub runner_token: String,
    pub chrome: String,
    pub ffmpeg: String,
    pub work_dir: PathBuf,
    pub pulse_sink: String,
    pub no_sandbox: bool,
    pub meet_origin: String,
    pub waiting_timeout: Duration,
    pub page_load_timeout: Duration,
    pub heartbeat: Duration,
    /// Silence before the bot assumes everyone left (warning + stop).
    pub idle_warning: Duration,
    pub idle_stop: Duration,
    pub segment_seconds: u32,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("server", &self.server)
            .field("runner_token", &"<redacted>")
            .finish()
    }
}

#[derive(Deserialize, Clone)]
pub struct Claim {
    pub attendance_id: Uuid,
    pub lease_token: Uuid,
    pub meet_code: String,
    pub title: String,
    pub display_name: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub leave_by: DateTime<Utc>,
    pub device_token: String,
    pub lease_seconds: i64,
}

impl std::fmt::Debug for Claim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Claim")
            .field("attendance_id", &self.attendance_id)
            .field("device_token", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed(String),
    /// The server gave the attendance to someone else; nothing was reported.
    LeaseLost,
}

pub struct Api {
    http: reqwest::blocking::Client,
    cfg: Config,
}

#[derive(Deserialize)]
struct Answer {
    #[serde(rename = "continue")]
    keep_going: bool,
}

pub enum Reported {
    Continue(bool),
    LeaseLost,
    Unreachable,
}

impl Api {
    pub fn new(cfg: Config) -> Result<Self, String> {
        let http = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { http, cfg })
    }

    /// `Ok(None)` when nothing is due.
    pub fn claim(&self) -> Result<Option<Claim>, String> {
        let res = self
            .http
            .post(format!("{}/v1/calendar-bot/claim", self.cfg.server))
            .bearer_auth(&self.cfg.runner_token)
            .send()
            .map_err(|e| format!("claim failed: {}", e.without_url()))?;
        match res.status().as_u16() {
            204 => Ok(None),
            200 => res
                .json()
                .map(Some)
                .map_err(|_| "claim answer unreadable".into()),
            c => Err(format!("claim refused with {c}")),
        }
    }

    pub fn report(
        &self,
        c: &Claim,
        state: &str,
        meeting: Option<&str>,
        detail: Option<&str>,
    ) -> Reported {
        let mut body = json!({"lease_token": c.lease_token, "state": state});
        if let Some(m) = meeting {
            body["meeting_id"] = json!(m);
        }
        if let Some(d) = detail {
            body["detail"] = json!(d.chars().take(200).collect::<String>());
        }
        let res = self
            .http
            .post(format!(
                "{}/v1/calendar-bot/attendances/{}/report",
                self.cfg.server, c.attendance_id
            ))
            .bearer_auth(&self.cfg.runner_token)
            .json(&body)
            .send();
        match res {
            Ok(r) if r.status().is_success() => r
                .json::<Answer>()
                .map(|a| Reported::Continue(a.keep_going))
                .unwrap_or(Reported::Unreachable),
            Ok(r) if r.status().as_u16() == 409 => Reported::LeaseLost,
            _ => Reported::Unreachable,
        }
    }
}

/// Shared between the job and its heartbeat thread.
struct Live {
    state: Mutex<(String, Option<String>)>,
    keep_going: AtomicBool,
    lease_lost: AtomicBool,
    done: AtomicBool,
}

pub fn run_job(api: &Api, job: Claim) -> Outcome {
    let cfg = &api.cfg;
    if !meet::valid_code(&job.meet_code) {
        let _ = api.report(&job, "failed", None, Some("invalid meeting code"));
        return Outcome::Failed("invalid meeting code".into());
    }
    let live = Arc::new(Live {
        state: Mutex::new(("joining".into(), None)),
        keep_going: AtomicBool::new(true),
        lease_lost: AtomicBool::new(false),
        done: AtomicBool::new(false),
    });
    match api.report(&job, "joining", None, None) {
        Reported::LeaseLost => return Outcome::LeaseLost,
        Reported::Continue(false) => {
            let _ = api.report(&job, "completed", None, Some("cancelled before joining"));
            return Outcome::Completed;
        }
        _ => {}
    }
    // Heartbeat: keeps the lease and learns about cancellation.
    let hb = {
        let live = live.clone();
        let job = job.clone();
        let api = Api {
            http: api.http.clone(),
            cfg: cfg.clone(),
        };
        let every = cfg.heartbeat;
        std::thread::spawn(move || {
            while !live.done.load(Ordering::SeqCst) {
                std::thread::sleep(every);
                if live.done.load(Ordering::SeqCst) {
                    break;
                }
                let (state, meeting) = live.state.lock().map(|g| g.clone()).unwrap_or_default();
                match api.report(&job, &state, meeting.as_deref(), None) {
                    Reported::Continue(k) => live.keep_going.store(k, Ordering::SeqCst),
                    Reported::LeaseLost => {
                        live.lease_lost.store(true, Ordering::SeqCst);
                        live.keep_going.store(false, Ordering::SeqCst);
                    }
                    Reported::Unreachable => {}
                }
            }
        })
    };
    let outcome = attend(api, &job, &live);
    live.done.store(true, Ordering::SeqCst);
    let _ = hb.join();
    if live.lease_lost.load(Ordering::SeqCst) {
        return Outcome::LeaseLost;
    }
    let meeting = live.state.lock().ok().and_then(|g| g.1.clone());
    let (state, detail) = match &outcome {
        Outcome::Completed => ("completed", None),
        Outcome::Failed(why) => ("failed", Some(why.as_str())),
        Outcome::LeaseLost => return Outcome::LeaseLost,
    };
    match api.report(&job, state, meeting.as_deref(), detail) {
        Reported::LeaseLost => Outcome::LeaseLost,
        _ => outcome,
    }
}

fn set_state(live: &Live, state: &str, meeting: Option<String>) {
    if let Ok(mut g) = live.state.lock() {
        g.0 = state.into();
        if meeting.is_some() {
            g.1 = meeting;
        }
    }
}

fn attend(api: &Api, job: &Claim, live: &Arc<Live>) -> Outcome {
    let cfg = &api.cfg;
    let dir = cfg.work_dir.join(job.attendance_id.to_string());
    let mut browser = match cdp::Browser::launch(cdp::LaunchOptions {
        chrome: &cfg.chrome,
        profile: dir.join("profile"),
        pulse_sink: &cfg.pulse_sink,
        no_sandbox: cfg.no_sandbox,
    }) {
        Ok(b) => b,
        Err(e) => return Outcome::Failed(format!("browser: {e}")),
    };
    let url = format!("{}/{}?hl=en", cfg.meet_origin, job.meet_code);
    let leave_by = job.leave_by;
    let keep = || live.keep_going.load(Ordering::SeqCst) && Utc::now() < leave_by;
    let mut on_waiting = || {
        set_state(live, "waiting", None);
        let _ = api.report(job, "waiting", None, None);
    };
    let joined = meet::join(
        &mut browser,
        &url,
        meet::JoinOptions {
            display_name: &job.display_name,
            page_load_timeout: cfg.page_load_timeout,
            waiting_timeout: cfg.waiting_timeout,
            on_waiting: &mut on_waiting,
            keep_going: &keep,
        },
    );
    match joined {
        Ok(meet::JoinOutcome::Admitted) => {}
        Ok(meet::JoinOutcome::Stopped) => return Outcome::Completed,
        Ok(meet::JoinOutcome::Refused) => {
            return Outcome::Failed("Google Meet did not let the notetaker join".into())
        }
        Ok(meet::JoinOutcome::NotAdmitted) => {
            return Outcome::Failed("nobody admitted the notetaker".into())
        }
        Err(e) => return Outcome::Failed(format!("joining failed: {e}")),
    }

    // Admitted: record what the meeting sounds like.
    let client = match recorder::Client::new(&cfg.server, &job.device_token) {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(format!("upload client: {e}")),
    };
    let events: Arc<Mutex<Vec<recorder::Event>>> = Arc::new(Mutex::new(Vec::new()));
    let remaining_ms = (leave_by - Utc::now()).num_milliseconds().max(60_000) as u64;
    let detector = DetectorConfig {
        idle_warning_after_ms: cfg.idle_warning.as_millis() as u64,
        idle_stop_after_warning_ms: cfg.idle_stop.as_millis() as u64,
        hard_max_ms: remaining_ms.min(4 * 3_600_000),
        hard_max_warning_ms: 60_000.min(remaining_ms / 2),
        ..DetectorConfig::default()
    };
    let session = recorder::Session::start(recorder::StartOptions {
        client,
        dir: dir.join("audio"),
        ffmpeg: cfg.ffmpeg.clone(),
        inputs: vec![recorder::ffmpeg::Input::LinuxPulse {
            source: format!("{}.monitor", cfg.pulse_sink),
        }],
        title: job.title.clone(),
        mode: CaptureMode::Audio,
        segment_seconds: cfg.segment_seconds,
        detector,
        watch_window: None,
        on_event: {
            let events = events.clone();
            Arc::new(move |e| {
                if let Ok(mut v) = events.lock() {
                    v.push(e);
                }
            })
        },
        upload_interval: Duration::from_secs(2),
        ready_timeout: Duration::from_secs(20),
    });
    let mut session = match session {
        Ok(s) => s,
        Err(e) => {
            meet::leave(&mut browser);
            return Outcome::Failed(format!("recording could not start: {e}"));
        }
    };
    let meeting_id = session.meeting_id.clone();
    set_state(live, "recording", Some(meeting_id.clone()));
    if let Reported::LeaseLost = api.report(job, "recording", Some(&meeting_id), None) {
        live.lease_lost.store(true, Ordering::SeqCst);
        live.keep_going.store(false, Ordering::SeqCst);
    }
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if !session.is_running() {
            break;
        }
        if !keep() {
            session.signal(cap_meeting_detector::Signal::UserStop);
            break;
        }
        if !browser.is_alive() {
            session.signal(cap_meeting_detector::Signal::MeetingEnded);
            break;
        }
        match meet::probe(&mut browser) {
            Ok(s) if s.ended || !s.in_call => {
                session.signal(cap_meeting_detector::Signal::MeetingEnded);
                break;
            }
            _ => {}
        }
        // Treat the detector's idle warning as "nobody is speaking": keep
        // going until it stops on its own (everyone left).
    }
    meet::leave(&mut browser);
    session.stop();
    drop(browser);
    let uploaded = session.wait_uploaded(Duration::from_secs(600));
    let ev = events.lock().map(|v| v.clone()).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    if ev
        .iter()
        .any(|e| matches!(e, recorder::Event::Finalized { .. }))
    {
        Outcome::Completed
    } else if let Some(recorder::Event::Failed { message, .. }) = ev
        .iter()
        .find(|e| matches!(e, recorder::Event::Failed { .. }))
    {
        Outcome::Failed(format!("upload failed: {message}"))
    } else if !uploaded {
        Outcome::Failed("upload did not finish in time".into())
    } else {
        Outcome::Failed("recording ended without being finalized".into())
    }
}
