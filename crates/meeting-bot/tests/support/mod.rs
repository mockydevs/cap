//! Runner container test helpers shared by attend.rs and composite.rs.

#![allow(clippy::unwrap_used, dead_code)]

#[path = "../../../cap-server/tests/support/calendar.rs"]
pub mod calendar;

pub use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
pub use calendar::{event, World, BOT_TOKEN};
pub use cap_server::{attendance, config::TranscriptionConfig, meetings::worker};
pub use chrono::{Duration, Utc};
pub use serde_json::Value;
pub use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
pub use uuid::Uuid;

pub const DON: &str = "cldon000000000000000000001";

pub fn page(long: bool, admit_after_ms: u64) -> String {
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
setInterval(() => fetch('/alive', {{method: 'POST'}}), 500);
const report = (k, v) => fetch('/seen', {{method: 'POST', headers: {{'content-type': 'application/json'}}, body: JSON.stringify({{k, v, t: Date.now()}})}});
$('mic').onclick = e => {{ report('mic', e.isTrusted); $('mic').setAttribute('aria-label', 'Turn on microphone'); }};
$('cam').onclick = e => {{ report('cam', e.isTrusted); $('cam').setAttribute('aria-label', 'Turn on camera'); }};
$('join').onclick = e => {{
  report('join', {{trusted: e.isTrusted, name: $('name').value, path: location.pathname}});
  $('pre').hidden = true; $('waiting').hidden = false;
  setTimeout(() => {{ $('waiting').hidden = true; $('incall').hidden = false; report('admitted', true);
    setTimeout(() => $('a').play().then(() => report('playing', true), err => report('play_error', String(err))), 4000); }}, {admit_after_ms});
}};
$('a').onended = () => setTimeout(() => {{ report('ended', true); $('incall').hidden = true; $('end').hidden = false; }}, 3000);
$('leave').onclick = e => report('leave', e.isTrusted);
</script></body></html>"#,
        loop_attr = if long { "loop" } else { "" },
        admit_after_ms = admit_after_ms
    )
}

pub async fn fake_meet(seen: Arc<Mutex<Vec<Value>>>, long: bool) -> String {
    fake_meet_with(seen, long, 2_500, Arc::new(AtomicU64::new(0))).await
}

/// `alive` receives the host time (ms) of the page's latest ping, so a test
/// can tell exactly when the runner's browser stopped.
pub async fn fake_meet_with(
    seen: Arc<Mutex<Vec<Value>>>,
    long: bool,
    admit_after_ms: u64,
    alive: Arc<AtomicU64>,
) -> String {
    let audio = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/speech.ogg"
    ))
    .unwrap();
    let html = page(long, admit_after_ms);
    let app = Router::new()
        .route(
            "/alive",
            post(move || {
                let alive = alive.clone();
                async move {
                    alive.store(now_ms() as u64, Ordering::SeqCst);
                    "ok"
                }
            }),
        )
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
pub struct Proxy {
    pub target: String,
    pub hang_reports: AtomicBool,
    /// Hang only reports carrying one of these states.
    pub hang_states: Mutex<Vec<String>>,
    pub fail_uploads: AtomicBool,
    pub claims: AtomicUsize,
    /// Arrival time (ms) of every report the proxy let through successfully.
    pub reports_ok: Mutex<Vec<u128>>,
    pub failed_uploads: AtomicUsize,
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

pub async fn forward(
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
    let state = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["state"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let hang_state = p.hang_states.lock().unwrap().contains(&state);
    if is_report && (p.hang_reports.load(Ordering::SeqCst) || hang_state) {
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
    // Only in-meeting reports renew the lease the runner relies on; its final
    // completed/failed report comes after it has already left.
    if is_report && status.is_success() && state != "completed" && state != "failed" {
        p.reports_ok.lock().unwrap().push(arrived);
    }
    (status, out, bytes)
}

pub async fn proxy(target: &str) -> (Arc<Proxy>, String) {
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

pub struct Container(pub String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}

pub struct Volume(pub String);
impl Drop for Volume {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["volume", "rm", "-f", &self.0])
            .output();
    }
}

pub fn start_runner(image: &str, server: &str, meet: &str, volume: &str) -> Container {
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

pub fn logs(c: &Container) -> String {
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

pub fn spool_listing(image: &str, volume: &str) -> String {
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

pub fn transcription() -> (TranscriptionConfig, bool) {
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
pub async fn ready_world(lease: i64) -> Option<(World, Uuid, Uuid, bool)> {
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

pub async fn state_of(w: &World, att: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(att)
        .fetch_one(&w.state.db)
        .await
        .unwrap()
}

pub async fn wait_for(w: &World, att: Uuid, want: &[&str], secs: u64) -> String {
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

pub fn check_delivery(w: &World, acme: Uuid, real_whisper: bool) {
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

pub async fn deliver(w: &World) {
    let t = std::time::Instant::now();
    while worker::run_once(&w.state, Utc::now()).await.unwrap() {}
    eprintln!("transcribed and delivered in {:?}", t.elapsed());
}
