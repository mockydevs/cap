//! The real runner container attends a local stand-in for Google Meet that
//! plays synthetic speech, records it through PulseAudio + FFmpeg, uploads
//! through Cap (via a fault-injecting proxy), and the transcript reaches a
//! verifying Calari stand-in with the right client. Opt-in:
//!
//!   CAP_TEST_DATABASE_URL=postgres://… CAP_TEST_BOT_IMAGE=cap-meeting-bot:calendar-test \
//!   [CAP_TEST_WHISPER_MODEL=~/.cache/cap-whisper/ggml-tiny.en.bin  (needs cap-server/local-whisper)] \
//!   cargo test -p cap-meeting-bot --features fake-meet --test attend -- --nocapture --test-threads=1
//!
//! No real meeting, Google account, Calari system or client is involved.

#![allow(clippy::unwrap_used)]

#[path = "../../cap-server/tests/support/calendar.rs"]
mod calendar;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use calendar::{event, World, BOT_TOKEN};
use cap_server::{attendance, config::TranscriptionConfig, meetings::worker};
use chrono::{Duration, Utc};
use serde_json::Value;
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const DON: &str = "cldon000000000000000000001";

fn page(long: bool) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Meet stand-in</title></head><body>
<div id="pre"><input type="text" aria-label="Your name" id="name">
<button aria-label="Turn off microphone" id="mic">mic</button>
<button aria-label="Turn off camera" id="cam">cam</button>
<button id="join"><span>Ask to join</span></button></div>
<div id="waiting" hidden>Asking to be let in…</div>
<div id="incall" hidden><p>In the call</p><button aria-label="Leave call" id="leave">leave</button><audio id="a" src="/speech.ogg" {loop_attr}></audio></div>
<div id="end" hidden>The meeting has ended</div>
<script>
const $ = id => document.getElementById(id);
const report = (k, v) => fetch('/seen', {{method: 'POST', headers: {{'content-type': 'application/json'}}, body: JSON.stringify({{k, v, t: Date.now()}})}});
$('mic').onclick = e => {{ report('mic', e.isTrusted); $('mic').setAttribute('aria-label', 'Turn on microphone'); }};
$('cam').onclick = e => {{ report('cam', e.isTrusted); $('cam').setAttribute('aria-label', 'Turn on camera'); }};
$('join').onclick = e => {{
  report('join', {{trusted: e.isTrusted, name: $('name').value, path: location.pathname}});
  $('pre').hidden = true; $('waiting').hidden = false;
  setTimeout(() => {{ $('waiting').hidden = true; $('incall').hidden = false; report('admitted', true);
    setTimeout(() => $('a').play().then(() => report('playing', true), err => report('play_error', String(err))), 4000); }}, 2500);
}};
$('a').onended = () => setTimeout(() => {{ report('ended', true); $('incall').hidden = true; $('end').hidden = false; }}, 3000);
$('leave').onclick = e => report('leave', e.isTrusted);
</script></body></html>"#,
        loop_attr = if long { "loop" } else { "" }
    )
}

async fn fake_meet(seen: Arc<Mutex<Vec<Value>>>, long: bool) -> String {
    let audio = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/speech.ogg"
    ))
    .unwrap();
    let html = page(long);
    let app = Router::new()
        .route(
            "/speech.ogg",
            get(move || {
                let a = audio.clone();
                async move { ([("content-type", "audio/ogg")], a) }
            }),
        )
        .route(
            "/seen",
            post(move |Json(v): Json<Value>| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(v);
                    "ok"
                }
            }),
        )
        .route(
            "/{code}",
            get(move || {
                let h = html.clone();
                async move { axum::response::Html(h) }
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

/// Sits between the runner and Cap; can hang reports or fail uploads.
#[derive(Default)]
struct Proxy {
    target: String,
    hang_reports: AtomicBool,
    fail_uploads: AtomicBool,
    claims: AtomicUsize,
    /// Arrival time (ms) of every report the proxy let through successfully.
    reports_ok: Mutex<Vec<u128>>,
    failed_uploads: AtomicUsize,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

async fn forward(
    State(p): State<Arc<Proxy>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let path = uri.path().to_owned();
    if path.ends_with("/claim") {
        p.claims.fetch_add(1, Ordering::SeqCst);
    }
    let is_report = path.ends_with("/report");
    if is_report && p.hang_reports.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        return (StatusCode::GATEWAY_TIMEOUT, HeaderMap::new(), Bytes::new());
    }
    let upload = (method == Method::PUT && path.contains("/chunks/"))
        || (method == Method::POST && path.ends_with("/finalize"));
    if upload && p.fail_uploads.load(Ordering::SeqCst) {
        p.failed_uploads.fetch_add(1, Ordering::SeqCst);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            HeaderMap::new(),
            Bytes::new(),
        );
    }
    let arrived = now_ms();
    let mut req = reqwest::Client::new().request(
        method.as_str().parse().unwrap(),
        format!(
            "{}{}",
            p.target,
            uri.path_and_query().map(|x| x.as_str()).unwrap_or("/")
        ),
    );
    for (k, v) in &headers {
        if k != "host" && k != "content-length" {
            req = req.header(k.as_str(), v.as_bytes());
        }
    }
    let res = req.body(body.to_vec()).send().await.unwrap();
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap();
    let mut out = HeaderMap::new();
    if let Some(ct) = res.headers().get("content-type") {
        out.insert("content-type", ct.to_str().unwrap().parse().unwrap());
    }
    let bytes = res.bytes().await.unwrap();
    if is_report && status.is_success() {
        p.reports_ok.lock().unwrap().push(arrived);
    }
    (status, out, bytes)
}

async fn proxy(target: &str) -> (Arc<Proxy>, String) {
    let p = Arc::new(Proxy {
        target: target.into(),
        ..Default::default()
    });
    let app = Router::new().fallback(forward).with_state(p.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (p, url)
}

struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}

struct Volume(String);
impl Drop for Volume {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["volume", "rm", "-f", &self.0])
            .output();
    }
}

fn start_runner(image: &str, server: &str, meet: &str, volume: &str) -> Container {
    let name = format!("cap-bot-e2e-{}", Uuid::new_v4().simple());
    let out = Command::new("docker")
        .args([
            "run",
            "-d",
            "--name",
            &name,
            "--network",
            "host",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,size=512m",
            "--shm-size",
            "512m",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "-v",
            &format!("{volume}:/var/lib/cap-bot"),
            "-e",
            "CAP_BOT_ENABLED=1",
            "-e",
            &format!("CAP_SERVER_URL={server}"),
            "-e",
            "CAP_BOT_ALLOW_HTTP=1",
            "-e",
            &format!("CAP_BOT_RUNNER_TOKEN={BOT_TOKEN}"),
            "-e",
            &format!("CAP_BOT_TEST_MEET_ORIGIN={meet}"),
            "-e",
            "CAP_BOT_HEARTBEAT_SECONDS=5",
            "-e",
            "CAP_BOT_WAITING_SECONDS=60",
            image,
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    Container(name)
}

fn logs(c: &Container) -> String {
    let l = Command::new("docker")
        .args(["logs", &c.0])
        .output()
        .unwrap();
    format!(
        "{}{}",
        String::from_utf8_lossy(&l.stdout),
        String::from_utf8_lossy(&l.stderr)
    )
}

fn spool_listing(image: &str, volume: &str) -> String {
    let out = Command::new("docker")
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{volume}:/var/lib/cap-bot"),
            "--entrypoint",
            "sh",
            image,
            "-c",
            "ls -A /var/lib/cap-bot",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn transcription() -> (TranscriptionConfig, bool) {
    match std::env::var("CAP_TEST_WHISPER_MODEL") {
        Ok(model) => (
            TranscriptionConfig::LocalWhisper {
                model_path: model.into(),
                threads: 4,
                language: Some("en".into()),
            },
            true,
        ),
        Err(_) => (TranscriptionConfig::TestFixture, false),
    }
}

/// A connected calendar with one Acme meeting starting in 30 s, prepared.
async fn ready_world(lease: i64) -> Option<(World, Uuid, Uuid, bool)> {
    let (t, real) = transcription();
    let w = World::with_settings(t, true, lease).await?;
    let acme = Uuid::new_v4();
    w.staff(DON, "don@calari.test");
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    w.connect(&don, "don@calari.test").await;
    w.google.lock().unwrap().add(
        "don@calari.test",
        event(
            "kickoff",
            Utc::now() + Duration::seconds(30),
            30,
            "abc-defg-hij",
            &["ceo@acme.test"],
        ),
    );
    w.sync(Utc::now()).await;
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let (att, st): (Uuid, String) = sqlx::query_as("SELECT id, state FROM calendar_attendances")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "ready");
    Some((w, att, acme, real))
}

async fn state_of(w: &World, att: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(att)
        .fetch_one(&w.state.db)
        .await
        .unwrap()
}

async fn wait_for(w: &World, att: Uuid, want: &[&str], secs: u64) -> String {
    let mut st = String::new();
    for _ in 0..secs {
        st = state_of(w, att).await;
        if want.contains(&st.as_str()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    st
}

fn check_delivery(w: &World, acme: Uuid, real_whisper: bool) {
    let c = w.calari.lock().unwrap();
    assert_eq!(c.bad_signatures, 0);
    assert_eq!(c.deliveries.len(), 1, "delivered exactly once");
    let d = &c.deliveries[0];
    assert_eq!(d["client_id"], acme.to_string());
    assert_eq!(d["context"]["pairing_kind"], "staff_client");
    assert_eq!(d["meeting"]["source"], "calendar_bot");
    assert_eq!(
        d["meeting"]["meeting_url"],
        "https://meet.google.com/abc-defg-hij"
    );
    let text = d["transcript"]["text"].as_str().unwrap().to_lowercase();
    eprintln!(
        "transcript provider/model: {} {}",
        d["transcript"]["provider"], d["transcript"]["model"]
    );
    eprintln!("transcript: {text}");
    if real_whisper {
        // The fixture is a synthetic staff briefing with an assigned task.
        for words in ["friday", "assigned to", "timeline"] {
            assert!(text.contains(words), "speech recognised ({words}): {text}");
        }
    }
}

async fn deliver(w: &World) {
    let t = std::time::Instant::now();
    while worker::run_once(&w.state, Utc::now()).await.unwrap() {}
    eprintln!("transcribed and delivered in {:?}", t.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runner_container_attends_records_and_delivers() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE (and CAP_TEST_DATABASE_URL) to run the runner end to end");
        return;
    };
    let Some((w, att, acme, real)) = ready_world(90).await else {
        return;
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let meet = fake_meet(seen.clone(), false).await;
    let (_p, server) = proxy(&w.cap).await;
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let started = std::time::Instant::now();
    let c = start_runner(&image, &server, &meet, &volume.0);
    let state = wait_for(&w, att, &["completed", "failed"], 180).await;
    eprintln!("runner log:\n{}", logs(&c));
    eprintln!("page events: {:?}", seen.lock().unwrap());
    let failure: Option<String> =
        sqlx::query_scalar("SELECT failure FROM calendar_attendances WHERE id = $1")
            .bind(att)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(state, "completed", "failure: {failure:?}");
    eprintln!("attended in {:?}", started.elapsed());
    {
        let s = seen.lock().unwrap();
        let get = |k: &str| s.iter().find(|v| v["k"] == k).map(|v| v["v"].clone());
        let join = get("join").expect("joined");
        assert_eq!(
            join["trusted"], true,
            "real input events, not scripted clicks"
        );
        assert_eq!(
            join["name"], "Calari Notetaker",
            "joins under its visible name"
        );
        assert_eq!(join["path"], "/abc-defg-hij");
        assert_eq!(
            get("mic"),
            Some(Value::Bool(true)),
            "microphone switched off"
        );
        assert_eq!(get("cam"), Some(Value::Bool(true)), "camera switched off");
        assert!(get("playing").is_some(), "{s:?}");
    }
    let kinds: Vec<String> = sqlx::query_scalar(
        "SELECT kind FROM calendar_attendance_log WHERE attendance_id = $1 ORDER BY id",
    )
    .bind(att)
    .fetch_all(&w.state.db)
    .await
    .unwrap();
    for k in [
        "claimed",
        "bot_joining",
        "bot_waiting",
        "bot_recording",
        "bot_completed",
    ] {
        assert!(kinds.iter().any(|x| x == k), "{k} missing from {kinds:?}");
    }
    deliver(&w).await;
    check_delivery(&w, acme, real);
    let receipt: Option<String> =
        sqlx::query_scalar("SELECT receipt_id FROM meeting_deliveries WHERE status = 'delivered'")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    eprintln!("Calari receipt: {receipt:?}");
    assert!(receipt.is_some());
    // Finalized: the spool is empty and the bot's device is revoked.
    assert_eq!(spool_listing(&image, &volume.0), "");
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let revoked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM meeting_devices WHERE device_kind = 'calendar_bot' AND revoked_at IS NOT NULL",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(revoked, 1);
    drop(c);
    w.drop_db().await;
}

/// Review round 1, P1 #1: reports stop getting through mid-recording. The
/// runner must stop capturing and leave by its local lease deadline, before
/// the server's lease expires, so no second runner can overlap it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unconfirmed_lease_stops_capture_before_server_expiry() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE");
        return;
    };
    const LEASE: i64 = 20;
    let Some((w, att, acme, _real)) = ready_world(LEASE).await else {
        return;
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    // A meeting that never ends on its own.
    let meet = fake_meet(seen.clone(), true).await;
    let (p, server) = proxy(&w.cap).await;
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let c = start_runner(&image, &server, &meet, &volume.0);
    assert_eq!(
        wait_for(&w, att, &["recording"], 120).await,
        "recording",
        "{}",
        logs(&c)
    );
    // Let some speech be recorded, then cut every report from now on.
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    p.hang_reports.store(true, Ordering::SeqCst);
    let cut = now_ms();
    // Wait well past the server lease.
    tokio::time::sleep(std::time::Duration::from_secs((LEASE as u64) + 25)).await;
    eprintln!("runner log:\n{}", logs(&c));
    eprintln!("page events: {:?}", seen.lock().unwrap());
    let last_ok = *p.reports_ok.lock().unwrap().iter().max().unwrap();
    assert!(last_ok <= cut + 1_000);
    let server_lease_end = last_ok + (LEASE as u128) * 1000;
    let leave = seen
        .lock()
        .unwrap()
        .iter()
        .find(|v| v["k"] == "leave")
        .map(|v| v["t"].as_u64().unwrap() as u128);
    let leave = leave.expect("the runner left the meeting");
    eprintln!(
        "last confirmed report {last_ok}, left at {leave} ({} ms later), server lease ends {server_lease_end}",
        leave.saturating_sub(last_ok)
    );
    assert!(
        leave < server_lease_end,
        "left before the server's lease ended"
    );
    // Capture stopped then too: the meeting it uploaded ends before the lease.
    let (ended, mstate): (Option<chrono::DateTime<Utc>>, String) =
        sqlx::query_as("SELECT ended_at, state FROM meeting_sessions")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_ne!(mstate, "recording", "finalized by the runner");
    let ended_ms = ended.unwrap().timestamp_millis() as u128;
    assert!(
        ended_ms <= server_lease_end,
        "audio ends {ended_ms} <= lease end {server_lease_end}"
    );
    // The server sees the lease lapse; with a meeting recorded it is never
    // re-queued, so nobody else records it.
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let st = state_of(&w, att).await;
    assert!(st == "failed" || st == "completed", "{st}");
    let meetings: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_sessions")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(meetings, 1);
    let joins = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["k"] == "join")
        .count();
    assert_eq!(joins, 1, "no rejoin");
    deliver(&w).await;
    {
        let c = w.calari.lock().unwrap();
        assert_eq!(c.deliveries.len(), 1);
        assert_eq!(c.deliveries[0]["client_id"], acme.to_string());
    }
    drop(c);
    w.drop_db().await;
}

/// Review round 1, P1 #2: uploads fail through the whole meeting and the
/// container is then replaced. The durable spool keeps the audio and its own
/// credential; the new container uploads and finalizes it once, without
/// joining the meeting again or creating a second meeting.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_outage_and_restart_deliver_once_without_rejoining() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE");
        return;
    };
    let Some((w, att, acme, real)) = ready_world(90).await else {
        return;
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let meet = fake_meet(seen.clone(), false).await;
    let (p, server) = proxy(&w.cap).await;
    p.fail_uploads.store(true, Ordering::SeqCst);
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let first = start_runner(&image, &server, &meet, &volume.0);
    let st = wait_for(&w, att, &["completed", "failed"], 300).await;
    eprintln!("first runner log:\n{}", logs(&first));
    assert_eq!(
        st, "failed",
        "an unfinished upload is not reported as success"
    );
    let failure: Option<String> =
        sqlx::query_scalar("SELECT failure FROM calendar_attendances WHERE id = $1")
            .bind(att)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert!(
        failure
            .as_deref()
            .unwrap_or("")
            .contains("kept on the runner"),
        "{failure:?}"
    );
    assert!(p.failed_uploads.load(Ordering::SeqCst) > 0);
    let chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_chunks")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(chunks, 0, "nothing reached the server");
    // The server's clean-up must not revoke the credential recovery needs.
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let revoked: i64 =
        sqlx::query_scalar("SELECT count(*) FROM meeting_devices WHERE revoked_at IS NOT NULL")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(revoked, 0);
    let before = spool_listing(&image, &volume.0);
    eprintln!("spool before restart: {before:?}");
    assert!(before.contains(&att.to_string()) && before.contains(".token"));
    // Container replaced; the network comes back.
    drop(first);
    p.fail_uploads.store(false, Ordering::SeqCst);
    let second = start_runner(&image, &server, &meet, &volume.0);
    let mut finalized = false;
    for _ in 0..120 {
        let m: Option<String> = sqlx::query_scalar("SELECT state FROM meeting_sessions")
            .fetch_optional(&w.state.db)
            .await
            .unwrap();
        if m.as_deref().is_some_and(|s| s != "recording") {
            finalized = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    eprintln!("second runner log:\n{}", logs(&second));
    assert!(finalized, "recovered meeting finalized");
    deliver(&w).await;
    check_delivery(&w, acme, real);
    let meetings: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_sessions")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(meetings, 1, "no second meeting");
    let joins = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["k"] == "join")
        .count();
    assert_eq!(joins, 1, "recovery never rejoins");
    // Spool is emptied once the server confirmed (recovery settles it).
    let mut empty = String::from("?");
    for _ in 0..30 {
        empty = spool_listing(&image, &volume.0);
        if empty.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    assert_eq!(empty, "");
    assert!(logs(&second).contains("recovered and finalized meeting"));
    drop(second);
    w.drop_db().await;
}
