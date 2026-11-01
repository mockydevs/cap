#![allow(clippy::unwrap_used)]

//! Real FFmpeg capture of a synthetic source, uploaded to the real Rust
//! server and delivered to a mock Calari. Needs `CAP_TEST_DATABASE_URL` and
//! `CAP_TEST_FFMPEG` (an FFmpeg binary or `tests/rust-e2e/ffmpeg-docker.sh`).

use cap_meeting_detector::Config as DetectorConfig;
use cap_meeting_protocol::{signing, CaptureMode, DeliveryPayload, StopReason};
use cap_meeting_recorder::{ffmpeg::Input, Client, Event, Journal, Session, StartOptions};
use cap_server::config::{Config, Integration, Secret, StorageConfig, TranscriptionConfig};
use std::{
    path::PathBuf,
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
            }],
            transcription: TranscriptionConfig::TestFixture,
            abandon_after: Duration::from_secs(3600),
            worker_interval: Duration::from_millis(100),
            site_dir: None,
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
    // Pair like Calari would, then redeem like the desktop app.
    let http = reqwest::blocking::Client::new();
    let body = serde_json::to_vec(&serde_json::json!({
        "request_id": uuid::Uuid::new_v4().to_string(), "tenant_id": TENANT, "pairing_kind": "internal_team", "ttl_seconds": 300
    }))
    .unwrap();
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
    Some(Env {
        server,
        token: r["device_token"].as_str().unwrap().to_owned(),
        state,
        rt,
        deliveries,
        ffmpeg,
    })
}

fn dir() -> PathBuf {
    let d = PathBuf::from(format!("/tmp/cap-recorder-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn start(
    e: &Env,
    dir: &std::path::Path,
    input: Input,
    detector: DetectorConfig,
) -> (Session, Arc<Mutex<Vec<Event>>>) {
    start_with(e, dir, vec![input], CaptureMode::Audio, detector)
}

fn start_with(
    e: &Env,
    dir: &std::path::Path,
    inputs: Vec<Input>,
    mode: CaptureMode,
    detector: DetectorConfig,
) -> (Session, Arc<Mutex<Vec<Event>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let s = Session::start(StartOptions {
        client: Client::new(&e.server, &e.token).unwrap(),
        dir: dir.to_path_buf(),
        ffmpeg: e.ffmpeg.clone(),
        inputs,
        title: "Synthetic test meeting".into(),
        mode,
        segment_seconds: 2,
        detector,
        watch_window: None,
        on_event: Box::new(move |ev| sink.lock().unwrap().push(ev)),
    })
    .unwrap();
    (s, events)
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

#[test]
fn source_ending_stops_finalizes_and_delivers_every_segment() {
    let Some(e) = env() else { return };
    let d = dir();
    let (session, events) = start(
        &e,
        &d,
        Input::Synthetic {
            seconds: 7,
            silent: false,
        },
        DetectorConfig::default(),
    );
    assert!(wait_for(Duration::from_secs(60), || !session.is_running()));
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

#[test]
fn user_stop_closes_the_last_segment_and_uploads_it() {
    let Some(e) = env() else { return };
    let d = dir();
    let (session, events) = start(
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
    let evs = events.lock().unwrap().clone();
    assert!(
        evs.contains(&Event::Stopped {
            reason: StopReason::UserStopped
        }),
        "{evs:?}"
    );
    let p = delivered(&e);
    assert_eq!(p.meeting.stop_reason, StopReason::UserStopped);
    let last = p.transcript.segments.last().unwrap();
    assert!(
        last.end_ms >= 4_000,
        "the final partial segment was included: {last:?}"
    );
    e.rt.block_on(e.state.db.close());
}

#[test]
fn prolonged_silence_warns_then_stops() {
    let Some(e) = env() else { return };
    let d = dir();
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
fn a_crashed_session_is_recovered_as_interrupted() {
    let Some(e) = env() else { return };
    let d = dir();
    // Record segments with FFmpeg directly, as if the app died before finalizing.
    let client = Client::new(&e.server, &e.token).unwrap();
    let m = client
        .create_meeting(&cap_meeting_protocol::CreateMeetingRequest {
            title: "crashed".into(),
            idempotency_key: "crash-1".into(),
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
        stop_reason: None,
        finalized: false,
    }
    .save(&d)
    .unwrap();
    let args = cap_meeting_recorder::ffmpeg::args(
        &[Input::Synthetic {
            seconds: 5,
            silent: false,
        }],
        CaptureMode::Audio,
        &d,
        2,
    );
    let status = std::process::Command::new(&e.ffmpeg)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let token = e.token.clone();
    let done = cap_meeting_recorder::recover_all(d.parent().unwrap(), |_| Some(token.clone()));
    assert!(done.contains(&m.id), "{done:?}");
    let p = delivered(&e);
    assert_eq!(p.meeting.stop_reason, StopReason::Interrupted);
    assert!(p.meeting.partial);
    e.rt.block_on(e.state.db.close());
}

#[test]
fn video_mode_uploads_webm_segments() {
    let Some(e) = env() else { return };
    let d = dir();
    let (session, _) = start_with(
        &e,
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
