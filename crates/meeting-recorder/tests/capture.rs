#![allow(clippy::unwrap_used)]

//! Real FFmpeg capture of a synthetic source, uploaded to the real Rust
//! server and delivered to a mock Calari. Needs `CAP_TEST_DATABASE_URL` and
//! `CAP_TEST_FFMPEG` (an FFmpeg binary or `tests/rust-e2e/ffmpeg-docker.sh`).

use cap_meeting_detector::Config as DetectorConfig;
use cap_meeting_protocol::{
    signing, CaptureMode, CreateMeetingRequest, DeliveryPayload, StopReason,
};
use cap_meeting_recorder::{
    ffmpeg::Input, Client, Event, Journal, Session, StartOptions, UploadOutcome,
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
    r["device_token"].as_str().unwrap().to_owned()
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
    let done = cap_meeting_recorder::recover_all(&root, |_| Some(token.clone()));
    assert_eq!(done, vec![id]);
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
    assert!(cap_meeting_recorder::recover_all(&root, |_| Some(token.clone())).is_empty());
    let after = Journal::load(&d).unwrap();
    assert!(after.uploaded.is_empty() && !after.finalized);
    let files = segment_files(&d);
    let mut j = after;
    j.server = real;
    j.save(&d).unwrap();
    assert_eq!(
        cap_meeting_recorder::recover_all(&root, |_| Some(token.clone())),
        vec![id]
    );
    let p = delivered(&e);
    assert_eq!(p.transcript.segments.len(), files, "every segment arrived");
    assert_eq!(segment_files(&d), files, "local files are never deleted");
    e.rt.block_on(e.state.db.close());
}

/// Review finding 2: an expired or replaced credential is not an upload, and
/// each meeting recovers with its own credential after re-pairing A→B.
#[test]
fn expired_or_replaced_credentials_never_lose_audio() {
    let Some(e) = env() else { return };
    let (root, d) = dir();
    let token_a = e.token.clone();
    let id = crashed_recording(&e, &d, &token_a, 5);
    e.rt.block_on(async {
        sqlx::query("UPDATE meeting_devices SET expires_at = now() - interval '1 second'")
            .execute(&e.state.db)
            .await
            .unwrap();
    });
    assert!(cap_meeting_recorder::recover_all(&root, |_| Some(token_a.clone())).is_empty());
    let j = Journal::load(&d).unwrap();
    assert!(
        j.uploaded.is_empty() && j.quarantined.is_empty() && !j.finalized,
        "{j:?}"
    );

    // The user pairs again (B). B cannot see meeting A's recording.
    let token_b = pair_token(&e.server);
    assert!(cap_meeting_recorder::recover_all(&root, |_| Some(token_b.clone())).is_empty());
    assert!(!Journal::load(&d).unwrap().finalized);
    assert!(e.deliveries.lock().unwrap().is_empty());

    // With meeting A's own (valid) credential it completes.
    e.rt.block_on(async {
        sqlx::query("UPDATE meeting_devices SET expires_at = now() + interval '1 hour'")
            .execute(&e.state.db)
            .await
            .unwrap();
    });
    let per_meeting = std::collections::HashMap::from([(id.clone(), token_a.clone())]);
    let done =
        cap_meeting_recorder::recover_all(&root, |j| per_meeting.get(&j.meeting_id).cloned());
    assert_eq!(done, vec![id]);
    assert!(!delivered(&e).transcript.segments.is_empty());
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
        cap_meeting_recorder::recover_all(&root, |_| Some(token.clone())),
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
