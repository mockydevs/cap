#![allow(clippy::unwrap_used)]

//! Real FFmpeg capture of a synthetic source, uploaded to the real Rust
//! server and delivered to a mock Calari. Needs `CAP_TEST_DATABASE_URL` and
//! `CAP_TEST_FFMPEG` (an FFmpeg binary or `tests/rust-e2e/ffmpeg-docker.sh`).

use cap_meeting_detector::Config as DetectorConfig;
use cap_meeting_protocol::{
    signing, CaptureMode, CreateMeetingRequest, DeliveryPayload, StopReason,
};
use cap_meeting_recorder::{
    ffmpeg::Input, Client, Event, Journal, Recovered, Session, StartOptions, UploadOutcome,
};
use cap_server::config::{Config, Integration, Secret, StorageConfig, TranscriptionConfig};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const SECRET: [u8; 32] = [7; 32];
const TENANT: &str = "00000000-0000-4000-8000-000000000001";

struct Env {
    server: String,
    token: String,
    state: cap_server::AppState,
    rt: tokio::runtime::Runtime,
    deliveries: Arc<Mutex<Vec<Vec<u8>>>>,
    ffmpeg: String,
}

fn env() -> Option<Env> {
    let (Ok(db), Ok(ffmpeg)) = (
        std::env::var("CAP_TEST_DATABASE_URL"),
        std::env::var("CAP_TEST_FFMPEG"),
    ) else {
        eprintln!("SKIPPED: set CAP_TEST_DATABASE_URL and CAP_TEST_FFMPEG");
        return None;
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let (server, state) = rt.block_on(async {
        let name = format!("r_{}", uuid::Uuid::new_v4().simple());
        let admin = sqlx::PgPool::connect(&db).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let url = format!("{}/{name}", db.rsplit_once('/').unwrap().0);
        let sink = deliveries.clone();
        let calari = axum::Router::new().route(
            "/deliver",
            axum::routing::post(move |body: axum::body::Bytes| {
                let sink = sink.clone();
                async move {
                    sink.lock().unwrap().push(body.to_vec());
                    r#"{"receipt_id":"r","status":"accepted"}"#
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let calari_url = format!("http://{}/deliver", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, calari).await.unwrap() });
        let cfg = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_url: Secret(url),
            storage: StorageConfig::Filesystem {
                root: std::env::temp_dir().join(format!("cap-rec-{name}")),
            },
            public_base_url: "http://cap.test".into(),
            production: false,
            trusted_proxy_hops: 0,
            integrations: vec![Integration {
                key_id: "k".into(),
                tenant_id: TENANT.into(),
                secret: SECRET.to_vec(),
                delivery_url: calari_url,
                login_authorize_url: None,
                login_exchange_url: None,
                login_status_url: None,
            }],
            transcription: TranscriptionConfig::TestFixture,
            abandon_after: Duration::from_secs(3600),
            worker_interval: Duration::from_millis(100),
            download_dir: None,
            portal_url: None,
            ffmpeg_path: "ffmpeg".into(),
        };
        let state = cap_server::AppState::new(cfg).await.unwrap();
        tokio::spawn(cap_server::meetings::worker::run(state.clone()));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", l.local_addr().unwrap());
        let app = cap_server::router(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        (server, state)
    });
    let token = pair_token(&server);
    Some(Env {
        server,
        token,
        state,
        rt,
        deliveries,
        ffmpeg,
    })
}

/// Pairs like Calari would, then redeems like the desktop app.
fn pair_token(server: &str) -> String {
    pair(server, None).0
}

/// Returns (device token, pairing id). `client` = None pairs an internal
/// team meeting; Some(id) pairs for that client from a staff page.
fn pair(server: &str, client: Option<&str>) -> (String, String) {
    let http = reqwest::blocking::Client::new();
    let request = match client {
        None => serde_json::json!({
            "request_id": uuid::Uuid::new_v4().to_string(), "tenant_id": TENANT, "pairing_kind": "internal_team", "ttl_seconds": 300
        }),
        Some(c) => serde_json::json!({
            "request_id": uuid::Uuid::new_v4().to_string(), "tenant_id": TENANT, "pairing_kind": "staff_client",
            "client_id": c, "ttl_seconds": 300
        }),
    };
    let body = serde_json::to_vec(&request).unwrap();
    let ts = chrono::Utc::now().timestamp();
    let nonce = signing::new_nonce();
    let p: serde_json::Value = http
        .post(format!("{server}/v1/pairings"))
        .header(signing::HEADER_KEY_ID, "k")
        .header(signing::HEADER_TIMESTAMP, ts.to_string())
        .header(signing::HEADER_NONCE, &nonce)
        .header(
            signing::HEADER_SIGNATURE,
            signing::sign(&SECRET, signing::Purpose::Pairing, ts, &nonce, &body).unwrap(),
        )
        .body(body)
        .send()
        .unwrap()
        .json()
        .unwrap();
    let r: serde_json::Value = http
        .post(format!("{server}/v1/pairings/redeem"))
        .json(&serde_json::json!({"code": p["code"], "device_name": "test", "device_kind": "desktop"}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    (
        r["device_token"].as_str().unwrap().to_owned(),
        p["pairing_id"].as_str().unwrap().to_owned(),
    )
}

/// A fresh parent folder per test, so recovery only sees this test's meetings.
fn dir() -> (PathBuf, PathBuf) {
    let root = PathBuf::from(format!("/tmp/cap-recorder-test-{}", uuid::Uuid::new_v4()));
    let d = root.join("meeting");
    std::fs::create_dir_all(&d).unwrap();
    (root, d)
}

type Events = Arc<Mutex<Vec<Event>>>;

fn start_with(
    client: Client,
    ffmpeg: &str,
    dir: &Path,
    inputs: Vec<Input>,
    mode: CaptureMode,
    detector: DetectorConfig,
) -> (Session, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let s = Session::start(StartOptions {
        client,
        dir: dir.to_path_buf(),
        ffmpeg: ffmpeg.to_owned(),
        inputs,
        title: "Synthetic test meeting".into(),
        mode,
        segment_seconds: 2,
        detector,
        watch_window: None,
        on_event: Arc::new(move |ev| sink.lock().unwrap().push(ev)),
        upload_interval: Duration::from_millis(500),
        ready_timeout: Duration::from_secs(15),
    })
    .unwrap();
    (s, events)
}

fn start(e: &Env, dir: &Path, input: Input, detector: DetectorConfig) -> (Session, Events) {
    start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        dir,
        vec![input],
        CaptureMode::Audio,
        detector,
    )
}

fn wait_for(deadline: Duration, mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn delivered(e: &Env) -> DeliveryPayload {
    assert!(
        wait_for(Duration::from_secs(30), || !e
            .deliveries
            .lock()
            .unwrap()
            .is_empty()),
        "no delivery"
    );
    serde_json::from_slice(&e.deliveries.lock().unwrap()[0]).unwrap()
}

/// Records `seconds` of synthetic audio into `dir` with FFmpeg alone, as if
/// the app had died before uploading anything, and writes its journal.
fn crashed_recording(e: &Env, dir: &Path, token: &str, seconds: u32) -> String {
    let client = Client::new(&e.server, token).unwrap();
    let m = client
        .create_meeting(&CreateMeetingRequest {
            title: "crashed".into(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            started_at: chrono::Utc::now(),
            capture_mode: CaptureMode::Audio,
            provider_hint: None,
            meeting_url: None,
        })
        .unwrap();
    Journal {
        meeting_id: m.id.clone(),
        server: e.server.clone(),
        mode: CaptureMode::Audio,
        uploaded: vec![],
        quarantined: vec![],
        stop_reason: None,
        finalized: false,
    }
    .save(dir)
    .unwrap();
    let args = cap_meeting_recorder::ffmpeg::args(
        &[Input::Synthetic {
            seconds,
            silent: false,
        }],
        CaptureMode::Audio,
        dir,
        2,
    );
    let status = std::process::Command::new(&e.ffmpeg)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    m.id
}

fn ids(done: Vec<Recovered>) -> Vec<String> {
    done.into_iter().map(|r| r.meeting_id).collect()
}

fn segment_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|f| f.file_name().to_string_lossy().starts_with("seg_"))
        .count()
}

#[test]
fn source_ending_stops_finalizes_and_delivers_every_segment() {
    let Some(e) = env() else { return };
    let (_, d) = dir();
    let (mut session, events) = start(
        &e,
        &d,
        Input::Synthetic {
            seconds: 7,
            silent: false,
        },
        DetectorConfig::default(),
    );
    assert!(wait_for(Duration::from_secs(60), || !session.is_running()));
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::DeviceLost
        }),
        "{evs:?}"
    );
    assert!(
        matches!(evs.last(), Some(Event::Finalized { .. })),
        "{evs:?}"
    );
    let p = delivered(&e);
    assert!(
        p.transcript.segments.len() >= 3,
        "{:?}",
        p.transcript.segments
    );
    let starts: Vec<u64> = p.transcript.segments.iter().map(|s| s.start_ms).collect();
    assert!(starts.windows(2).all(|w| w[0] < w[1]), "{starts:?}");
    assert!(!p.meeting.partial);
    assert!(Journal::load(&d).unwrap().finalized);
    e.rt.block_on(e.state.db.close());
}

/// The raw-PCM pipe path used for Windows loopback (and the macOS helper):
/// a paced writer that goes quiet must not stall FFmpeg's mix with the
/// microphone. Linux FIFO here; the Windows named pipe and WASAPI capture
/// themselves need a Windows machine.
#[cfg(unix)]
#[test]
fn a_paced_system_audio_pipe_mixes_with_the_microphone() {
    use cap_meeting_recorder::system_audio::{Pacer, FRAME_BYTES};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let fifo = root.join("system-audio.pcm");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let fifo = fifo.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            // Blocks until FFmpeg opens the pipe, like the Windows writer.
            let mut out = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
            let start = Instant::now();
            let mut pacer = Pacer::new(start);
            let mut n = 0u64;
            while !done.load(Ordering::SeqCst) {
                // 2 s of "the other side talking", then nothing playing.
                let talking = start.elapsed() < Duration::from_secs(2);
                let captured = if talking { 480 } else { 0 };
                let plan = pacer.plan(Instant::now(), captured);
                let mut buf = Vec::with_capacity((plan.keep + plan.silence) as usize * FRAME_BYTES);
                for _ in 0..plan.keep {
                    let v = ((n as f32) * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.3;
                    n += 1;
                    buf.extend(v.to_le_bytes());
                    buf.extend(v.to_le_bytes());
                }
                buf.resize(buf.len() + plan.silence as usize * FRAME_BYTES, 0);
                if out.write_all(&buf).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let (mut session, events) = start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        &d,
        vec![
            Input::Synthetic {
                seconds: 60,
                silent: false,
            },
            Input::PcmPipe {
                path: fifo.to_string_lossy().into_owned(),
            },
        ],
        CaptureMode::Audio,
        DetectorConfig::default(),
    );
    std::thread::sleep(Duration::from_secs(7));
    let stopped_at = Instant::now();
    session.stop();
    assert!(
        stopped_at.elapsed() < Duration::from_secs(5),
        "stop waited on the pipe"
    );
    done.store(true, Ordering::SeqCst);
    let _ = writer.join();
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::UserStopped
        }),
        "{evs:?}"
    );
    let p = delivered(&e);
    // 2-second segments over ~7 s: the mix kept running after the pipe went
    // quiet, and kept up in real time (FFmpeg 8 probing a raw pipe used to
    // hold everything back, so the last seconds were lost at stop).
    assert!(
        p.transcript.segments.len() >= 3,
        "{:?}",
        p.transcript.segments
    );
    let recorded = p.transcript.segments.last().map_or(0, |s| s.end_ms);
    assert!(recorded >= 6_000, "only {recorded} ms of ~7 s recorded");
    e.rt.block_on(e.state.db.close());
}

/// Decodes a meeting's local segments to 8 kHz mono samples.
#[cfg(unix)]
fn decoded_segments(ffmpeg: &str, dir: &Path) -> Vec<i16> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "ogg"))
        .collect();
    files.sort();
    let mut samples = Vec::new();
    for f in files {
        let out = std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&f)
            .args(["-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
            .output()
            .unwrap();
        samples.extend(
            out.stdout
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]])),
        );
    }
    samples
}

/// Level of one frequency (Goertzel), per sample.
#[cfg(unix)]
fn tone_level(samples: &[i16], freq: f64) -> f64 {
    let k = 2.0 * (2.0 * std::f64::consts::PI * freq / 8000.0).cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &v in samples {
        let s0 = f64::from(v) + k * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - k * s1 * s2).max(0.0).sqrt() / samples.len().max(1) as f64
}

/// Stopping cuts capture at once yet keeps what was captured before it: a
/// tone played only after Stop is absent, and the audio before Stop is all
/// there. (FFmpeg used to hold ~2 s of output, which "q" dropped.)
#[cfg(unix)]
#[test]
fn stop_keeps_audio_up_to_stop_and_nothing_after() {
    use cap_meeting_recorder::system_audio::{Pacer, FRAME_BYTES};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let fifo = root.join("system-audio.pcm");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let stopped = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let (fifo, stopped, done) = (fifo.clone(), stopped.clone(), done.clone());
        std::thread::spawn(move || {
            let mut out = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
            let mut pacer = Pacer::new(Instant::now());
            let mut n = 0u64;
            while !done.load(Ordering::SeqCst) {
                // 440 Hz before Stop, 1000 Hz after it.
                let freq = if stopped.load(Ordering::SeqCst) {
                    1000.0
                } else {
                    440.0
                };
                let plan = pacer.plan(Instant::now(), 480);
                let mut buf = Vec::with_capacity(plan.keep as usize * FRAME_BYTES);
                for _ in 0..plan.keep {
                    let v = ((n as f32) * freq * std::f32::consts::TAU / 48_000.0).sin() * 0.4;
                    n += 1;
                    buf.extend(v.to_le_bytes());
                    buf.extend(v.to_le_bytes());
                }
                if out.write_all(&buf).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let (mut session, _events) = start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        &d,
        vec![Input::PcmPipe {
            path: fifo.to_string_lossy().into_owned(),
        }],
        CaptureMode::Audio,
        DetectorConfig::default(),
    );
    let started = Instant::now();
    std::thread::sleep(Duration::from_secs(6));
    stopped.store(true, Ordering::SeqCst);
    let before_stop = started.elapsed();
    session.stop();
    // Keep the "after Stop" tone playing for a while before closing the pipe.
    std::thread::sleep(Duration::from_secs(2));
    done.store(true, Ordering::SeqCst);
    let _ = writer.join();
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let samples = decoded_segments(&e.ffmpeg, &d);
    let seconds = samples.len() as f64 / 8000.0;
    let (before, after) = (tone_level(&samples, 440.0), tone_level(&samples, 1000.0));
    eprintln!(
        "kept {seconds:.2} s of {:.2} s before Stop; 440 Hz {before:.1}, 1000 Hz {after:.1}",
        before_stop.as_secs_f64()
    );
    assert!(
        seconds >= before_stop.as_secs_f64() - 1.0,
        "only {seconds:.2} s kept of {:.2} s before Stop",
        before_stop.as_secs_f64()
    );
    assert!(after < before / 20.0, "audio from after Stop was recorded");
    e.rt.block_on(e.state.db.close());
}

/// "Recording" is reported only once capture produces audio: a source that
/// takes 2 s to start keeps the session starting, and the first sound after
/// that is in the recording.
#[cfg(unix)]
#[test]
fn recording_starts_only_once_audio_arrives_and_keeps_the_first_sound() {
    use cap_meeting_recorder::system_audio::{Pacer, FRAME_BYTES};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let fifo = root.join("slow-device.pcm");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let (fifo, done) = (fifo.clone(), done.clone());
        std::thread::spawn(move || {
            // The "device" starts 2 s late, then plays 700 Hz for 0.5 s
            // (the first words) and 440 Hz after that.
            std::thread::sleep(Duration::from_secs(2));
            let mut out = std::fs::OpenOptions::new().write(true).open(&fifo).unwrap();
            let start = Instant::now();
            let mut pacer = Pacer::new(start);
            let mut n = 0u64;
            while !done.load(Ordering::SeqCst) {
                let freq = if start.elapsed() < Duration::from_millis(500) {
                    700.0
                } else {
                    440.0
                };
                let plan = pacer.plan(Instant::now(), 480);
                let mut buf = Vec::with_capacity(plan.keep as usize * FRAME_BYTES);
                for _ in 0..plan.keep {
                    let v = ((n as f32) * freq * std::f32::consts::TAU / 48_000.0).sin() * 0.4;
                    n += 1;
                    buf.extend(v.to_le_bytes());
                    buf.extend(v.to_le_bytes());
                }
                if out.write_all(&buf).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let asked = Instant::now();
    let (mut session, _events) = start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        &d,
        vec![Input::PcmPipe {
            path: fifo.to_string_lossy().into_owned(),
        }],
        CaptureMode::Audio,
        DetectorConfig::default(),
    );
    let starting = asked.elapsed();
    assert!(
        starting >= Duration::from_millis(1_900),
        "reported recording after {starting:?}, before any audio"
    );
    std::thread::sleep(Duration::from_secs(3));
    session.stop();
    done.store(true, Ordering::SeqCst);
    let _ = writer.join();
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let samples = decoded_segments(&e.ffmpeg, &d);
    let head = &samples[..samples.len().min(8_000)]; // first second
    let (first, later) = (tone_level(head, 700.0), tone_level(&samples, 440.0));
    eprintln!(
        "starting took {starting:?}; kept {:.2} s; first second 700 Hz {first:.1}; 440 Hz {later:.1}",
        samples.len() as f64 / 8000.0
    );
    assert!(
        first > later / 4.0,
        "the first sound after Recording is missing"
    );
    assert!(samples.len() as f64 / 8000.0 >= 2.5);
    e.rt.block_on(e.state.db.close());
}

/// A device that never produces audio: starting fails within the time
/// limit, FFmpeg is stopped, no meeting exists on the server and no local
/// folder is left.
#[cfg(unix)]
#[test]
fn a_device_that_never_starts_fails_cleanly() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let fifo = root.join("dead-device.pcm");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let asked = Instant::now();
    let result = Session::start(StartOptions {
        client: Client::new(&e.server, &e.token).unwrap(),
        dir: d.clone(),
        ffmpeg: e.ffmpeg.clone(),
        inputs: vec![Input::PcmPipe {
            path: fifo.to_string_lossy().into_owned(),
        }],
        title: "Never starts".into(),
        mode: CaptureMode::Audio,
        segment_seconds: 2,
        detector: DetectorConfig::default(),
        watch_window: None,
        on_event: Arc::new(|_| {}),
        upload_interval: Duration::from_millis(500),
        ready_timeout: Duration::from_secs(2),
    });
    let took = asked.elapsed();
    let error = result.err().expect("start must fail").to_string();
    assert!(error.contains("no audio arrived"), "{error}");
    assert!(took < Duration::from_secs(6), "gave up after {took:?}");
    assert!(!d.exists(), "local meeting folder left behind");
    let meetings: i64 =
        e.rt.block_on(
            sqlx::query_scalar("SELECT count(*) FROM meeting_sessions").fetch_one(&e.state.db),
        )
        .unwrap();
    assert_eq!(
        meetings, 0,
        "a meeting was created for a device that never started"
    );
    e.rt.block_on(e.state.db.close());
}

/// Real PulseAudio capture with the inputs the app picks on Linux: the
/// default microphone plus the speakers' monitor. Needs a running PulseAudio
/// (or PipeWire-Pulse) with something playing on both; see
/// `scripts/desktop/pulse-capture-smoke.sh`.
#[test]
fn linux_records_the_microphone_and_the_speakers_through_pulse() {
    use cap_meeting_recorder::devices::{self, InputChoice, Platform};
    if std::env::var("CAP_TEST_PULSE").as_deref() != Ok("1") {
        eprintln!("SKIPPED: set CAP_TEST_PULSE=1 with PulseAudio running");
        return;
    }
    let Some(e) = env() else { return };
    let found = devices::list_audio_devices(&e.ffmpeg, Platform::Linux);
    assert!(
        found.iter().any(|d| d.loopback),
        "no monitor source: {found:?}"
    );
    assert!(devices::system_audio_available(Platform::Linux, &found));
    let inputs = devices::resolve_inputs(
        Platform::Linux,
        &InputChoice {
            mode: CaptureMode::Audio,
            microphone_id: None,
            system_audio: true,
            screen: None,
            x11_display: None,
        },
        &found,
    )
    .unwrap();
    assert_eq!(
        inputs,
        vec![
            Input::LinuxPulse {
                source: "default".into()
            },
            Input::LinuxMonitor
        ]
    );
    // Both sources start muted; unmuting a capture source is instant, so the
    // test controls exactly when sound exists.
    let mute = |source: &str, on: bool| {
        assert!(std::process::Command::new("pactl")
            .args(["set-source-mute", source, if on { "1" } else { "0" }])
            .status()
            .unwrap()
            .success());
    };
    mute("@DEFAULT_SOURCE@", true);
    mute("@DEFAULT_MONITOR@", true);
    let (_, d) = dir();
    let asked = Instant::now();
    let (mut session, events) = start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        &d,
        inputs,
        CaptureMode::Audio,
        DetectorConfig::default(),
    );
    // "First words": the microphone sounds for 0.7 s right after Recording
    // is reported. They must be in the recording (no start-up gap).
    // The recording starts when FFmpeg starts, so they sit about `starting` in.
    let starting = asked.elapsed().as_secs_f64();
    mute("@DEFAULT_SOURCE@", false);
    std::thread::sleep(Duration::from_millis(700));
    mute("@DEFAULT_SOURCE@", true);
    // Silence, then the other side speaks in the last 1.5 s before Stop.
    std::thread::sleep(Duration::from_millis(7_800));
    mute("@DEFAULT_MONITOR@", false);
    std::thread::sleep(Duration::from_millis(1_500));
    session.stop();
    mute("@DEFAULT_MONITOR@", true);
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::UserStopped
        }),
        "{evs:?}"
    );
    let p = delivered(&e);
    let spans: Vec<_> = p
        .transcript
        .segments
        .iter()
        .map(|s| (s.start_ms, s.end_ms))
        .collect();
    let recorded = p.transcript.segments.last().map_or(0, |s| s.end_ms);
    let samples = decoded_segments(&e.ffmpeg, &d);
    let at = |from: f64, to: f64| {
        let n = samples.len();
        &samples[((from * 8000.0) as usize).min(n)..((to * 8000.0) as usize).min(n)]
    };
    let secs = samples.len() as f64 / 8000.0;
    let first_words = tone_level(at(starting - 0.3, starting + 1.2), 330.0);
    let quiet = (
        tone_level(at(starting + 1.5, starting + 7.0), 330.0),
        tone_level(at(starting + 1.5, starting + 7.0), 550.0),
    );
    let before_stop = tone_level(at(secs - 1.5, secs), 550.0);
    eprintln!(
        "pulse recorded {recorded} ms ({secs:.2} s decoded): {spans:?}; Recording after {starting:.2} s; first words 330 Hz {first_words:.1}; quiet middle 330/550 Hz {:.1}/{:.1}; last 1.5 s 550 Hz {before_stop:.1}",
        quiet.0, quiet.1
    );
    let per_second: Vec<String> = (0..secs as usize)
        .map(|i| {
            let w = at(i as f64, i as f64 + 1.0);
            format!(
                "{i}:{:.0}/{:.0}",
                tone_level(w, 330.0),
                tone_level(w, 550.0)
            )
        })
        .collect();
    eprintln!("per second 330/550 Hz: {}", per_second.join(" "));
    assert!(p.transcript.segments.len() >= 3, "{spans:?}");
    assert!(
        recorded >= 9_000,
        "only {recorded} ms kept of 10 s after Recording"
    );
    assert!(
        first_words > 200.0,
        "the first words after Recording are missing"
    );
    assert!(before_stop > 200.0, "the audio just before Stop is missing");
    assert!(
        quiet.0 < 50.0 && quiet.1 < 50.0,
        "sound where there was none: markers misplaced"
    );
    e.rt.block_on(e.state.db.close());
}

#[test]
fn user_stop_closes_the_last_segment_and_uploads_it() {
    let Some(e) = env() else { return };
    let (_, d) = dir();
    let (mut session, events) = start(
        &e,
        &d,
        Input::Synthetic {
            seconds: 120,
            silent: false,
        },
        DetectorConfig::default(),
    );
    std::thread::sleep(Duration::from_secs(5));
    session.stop();
    assert!(session.wait_uploaded(Duration::from_secs(60)));
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::UserStopped
        }),
        "{evs:?}"
    );
    let p = delivered(&e);
    assert_eq!(p.meeting.stop_reason, StopReason::UserStopped);
    // Every segment FFmpeg wrote, including the final partial one, arrived.
    let files = segment_files(&d);
    assert!(files >= 2, "{files} segment files");
    assert_eq!(
        p.transcript.segments.len(),
        files,
        "{:?}",
        p.transcript.segments
    );
    e.rt.block_on(e.state.db.close());
}

#[test]
fn prolonged_silence_warns_then_stops() {
    let Some(e) = env() else { return };
    let (_, d) = dir();
    let cfg = DetectorConfig {
        idle_warning_after_ms: 2_000,
        idle_stop_after_warning_ms: 2_000,
        ..DetectorConfig::default()
    };
    let (session, events) = start(
        &e,
        &d,
        Input::Synthetic {
            seconds: 120,
            silent: true,
        },
        cfg,
    );
    assert!(wait_for(Duration::from_secs(60), || !session.is_running()));
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.iter().any(|ev| matches!(
            ev,
            Event::Warning {
                reason: "inactivity",
                ..
            }
        )),
        "{evs:?}"
    );
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::ProlongedInactivity
        }),
        "{evs:?}"
    );
    assert_eq!(
        delivered(&e).meeting.stop_reason,
        StopReason::ProlongedInactivity
    );
    e.rt.block_on(e.state.db.close());
}

#[test]
fn video_mode_uploads_webm_segments() {
    let Some(e) = env() else { return };
    let (_, d) = dir();
    let (session, _) = start_with(
        Client::new(&e.server, &e.token).unwrap(),
        &e.ffmpeg,
        &d,
        vec![
            Input::SyntheticVideo { seconds: 5 },
            Input::Synthetic {
                seconds: 5,
                silent: false,
            },
        ],
        CaptureMode::Video,
        DetectorConfig::default(),
    );
    assert!(wait_for(Duration::from_secs(60), || !session.is_running()));
    let p = delivered(&e);
    assert_eq!(p.context.capture_mode, CaptureMode::Video);
    assert!(std::fs::read_dir(&d)
        .unwrap()
        .flatten()
        .any(|f| f.file_name().to_string_lossy().ends_with(".webm")));
    assert!(p.transcript.segments.len() >= 2);
    e.rt.block_on(e.state.db.close());
}

#[test]
fn a_crashed_session_is_recovered_as_interrupted() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let id = crashed_recording(&e, &d, &e.token, 5);
    let token = e.token.clone();
    let done = cap_meeting_recorder::recover_all(&root, |_| vec![token.clone()]);
    assert_eq!(ids(done), vec![id]);
    let p = delivered(&e);
    assert_eq!(p.meeting.stop_reason, StopReason::Interrupted);
    assert!(p.meeting.partial);
    e.rt.block_on(e.state.db.close());
}

/// Review finding 4: a stalled upload must not delay Stop.
#[test]
fn a_stalled_upload_never_delays_stop() {
    let Ok(ffmpeg) = std::env::var("CAP_TEST_FFMPEG") else {
        return;
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let server = rt.block_on(async {
        let meeting = serde_json::json!({
            "id": "00000000-0000-4000-8000-0000000000aa", "pairing_kind": "internal_team", "capture_mode": "audio",
            "client_id": null, "title": "t", "state": "recording", "received_chunks": 0, "missing_chunks": [],
            "stop_reason": null, "delivery": null, "failure": null
        });
        let app = axum::Router::new()
            .route("/v1/meetings", axum::routing::post(move || async move { (axum::http::StatusCode::CREATED, axum::Json(meeting)) }))
            .route(
                "/v1/meetings/{id}/chunks/{seq}",
                axum::routing::put(|| async {
                    tokio::time::sleep(Duration::from_secs(600)).await;
                    "never"
                }),
            );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        url
    });
    let (_, d) = dir();
    let (mut session, events) = start_with(
        Client::new(&server, &format!("capdev_{}", "1".repeat(64))).unwrap(),
        &ffmpeg,
        &d,
        vec![Input::Synthetic {
            seconds: 120,
            silent: false,
        }],
        CaptureMode::Audio,
        DetectorConfig::default(),
    );
    std::thread::sleep(Duration::from_secs(5)); // segments exist, first upload is hanging
    let t = Instant::now();
    session.stop();
    let took = t.elapsed();
    assert!(took < Duration::from_secs(12), "stop took {took:?}");
    assert!(events.lock().unwrap().contains(&Event::Stopped {
        reason: StopReason::UserStopped
    }));
    assert!(segment_files(&d) >= 2, "audio stays on disk");
    let j = Journal::load(&d).unwrap();
    assert!(j.uploaded.is_empty() && !j.finalized);
}

/// Review finding 2: an outage keeps audio and finalizes later, complete.
#[test]
fn an_outage_keeps_audio_until_the_server_is_back() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let id = crashed_recording(&e, &d, &e.token, 5);
    let mut j = Journal::load(&d).unwrap();
    let real = j.server.clone();
    j.server = "http://127.0.0.1:9".into(); // nothing listens here
    j.save(&d).unwrap();
    let token = e.token.clone();
    assert!(cap_meeting_recorder::recover_all(&root, |_| vec![token.clone()]).is_empty());
    let after = Journal::load(&d).unwrap();
    assert!(after.uploaded.is_empty() && !after.finalized);
    let files = segment_files(&d);
    let mut j = after;
    j.server = real;
    j.save(&d).unwrap();
    assert_eq!(
        ids(cap_meeting_recorder::recover_all(&root, |_| vec![
            token.clone()
        ])),
        vec![id]
    );
    let p = delivered(&e);
    assert_eq!(p.transcript.segments.len(), files, "every segment arrived");
    assert_eq!(segment_files(&d), files, "local files are never deleted");
    e.rt.block_on(e.state.db.close());
}

/// Review finding 2 (and re-review): an expired credential is not an upload,
/// a pairing for another client cannot take the meeting, and a real new
/// pairing for the same client finishes it with the original binding.
#[test]
fn a_same_client_re_pairing_finishes_an_expired_meeting() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let client_x = "00000000-0000-4000-8000-0000000000c1";
    let (token_a, pairing_a) = pair(&e.server, Some(client_x));
    let id = crashed_recording(&e, &d, &token_a, 5);
    // Twelve hours pass: A's credential expires (time is simulated; the
    // recovery below uses real pairings only).
    e.rt.block_on(async {
        sqlx::query("UPDATE meeting_devices SET expires_at = now() - interval '1 second'")
            .execute(&e.state.db)
            .await
            .unwrap();
    });
    assert!(cap_meeting_recorder::recover_all(&root, |_| vec![token_a.clone()]).is_empty());
    let j = Journal::load(&d).unwrap();
    assert!(
        j.uploaded.is_empty() && j.quarantined.is_empty() && !j.finalized,
        "{j:?}"
    );

    // Paired again, but for a different client: may not take the meeting.
    let (token_y, _) = pair(&e.server, Some("00000000-0000-4000-8000-0000000000c2"));
    assert!(
        cap_meeting_recorder::recover_all(&root, |_| vec![token_a.clone(), token_y.clone()])
            .is_empty()
    );
    assert!(!Journal::load(&d).unwrap().finalized);
    assert!(e.deliveries.lock().unwrap().is_empty());

    // Paired again for the same client: takes over and finishes.
    let (token_b, _) = pair(&e.server, Some(client_x));
    let done = cap_meeting_recorder::recover_all(&root, |_| vec![token_a.clone(), token_b.clone()]);
    assert_eq!(
        done,
        vec![Recovered {
            meeting_id: id,
            token: token_b
        }]
    );
    let p = delivered(&e);
    assert_eq!(p.client_id.as_deref(), Some(client_x));
    assert_eq!(
        p.pairing_id, pairing_a,
        "the delivery keeps the pairing Calari authorised"
    );
    e.rt.block_on(e.state.db.close());
}

/// Review finding 2: a refused chunk is quarantined (kept), and only then is
/// the gap accepted.
#[test]
fn a_conflicting_chunk_is_quarantined_not_deleted() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let id = crashed_recording(&e, &d, &e.token, 5);
    // Different bytes already occupy slot 0 on the server.
    let client = Client::new(&e.server, &e.token).unwrap();
    let mut other = b"OggS\0\x02".to_vec();
    other.extend([9u8; 64]);
    let seg0 = cap_meeting_recorder::ffmpeg::Segment {
        seq: 0,
        file: "x.ogg".into(),
        start_ms: 0,
        end_ms: 2_000,
    };
    assert_eq!(
        client.upload(&id, &seg0, other),
        UploadOutcome::Acknowledged
    );
    let token = e.token.clone();
    assert_eq!(
        ids(cap_meeting_recorder::recover_all(&root, |_| vec![
            token.clone()
        ])),
        vec![id]
    );
    let j = Journal::load(&d).unwrap();
    assert_eq!(j.quarantined, vec![0]);
    assert!(
        d.join("seg_000000.ogg").is_file(),
        "quarantined audio stays on disk"
    );
    assert!(delivered(&e).meeting.partial);
    e.rt.block_on(e.state.db.close());
}
