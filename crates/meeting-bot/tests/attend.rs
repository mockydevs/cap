//! The real runner container attends a local stand-in for Google Meet that
//! plays synthetic speech, records it through PulseAudio + FFmpeg, uploads
//! through Cap, and the transcript reaches a verifying Calari stand-in with
//! the right client. Opt-in:
//!
//!   CAP_TEST_DATABASE_URL=postgres://… CAP_TEST_BOT_IMAGE=cap-meeting-bot:calendar-test \
//!   [CAP_TEST_WHISPER_MODEL=~/.cache/cap-whisper/ggml-tiny.en.bin  (needs cap-server/local-whisper)] \
//!   cargo test -p cap-meeting-bot --features fake-meet --test attend -- --nocapture
//!
//! No real meeting, Google account, Calari system or client is involved.

#![allow(clippy::unwrap_used)]

#[path = "../../cap-server/tests/support/calendar.rs"]
mod calendar;

use axum::{routing::get, routing::post, Json, Router};
use calendar::{event, World, BOT_TOKEN};
use cap_server::{attendance, config::TranscriptionConfig, meetings::worker};
use chrono::{Duration, Utc};
use serde_json::Value;
use std::{
    process::Command,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const PAGE: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Meet stand-in</title></head><body>
<div id="pre"><input type="text" aria-label="Your name" id="name">
<button aria-label="Turn off microphone" id="mic">mic</button>
<button aria-label="Turn off camera" id="cam">cam</button>
<button id="join"><span>Ask to join</span></button></div>
<div id="waiting" hidden>Asking to be let in…</div>
<div id="incall" hidden><p>In the call</p><button aria-label="Leave call" id="leave">leave</button><audio id="a" src="/speech.ogg"></audio></div>
<div id="end" hidden>The meeting has ended</div>
<script>
const $ = id => document.getElementById(id);
const report = (k, v) => fetch('/seen', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({k, v})});
$('mic').onclick = e => { report('mic', e.isTrusted); $('mic').setAttribute('aria-label', 'Turn on microphone'); };
$('cam').onclick = e => { report('cam', e.isTrusted); $('cam').setAttribute('aria-label', 'Turn on camera'); };
$('join').onclick = e => {
  report('join', {trusted: e.isTrusted, name: $('name').value, path: location.pathname});
  $('pre').hidden = true; $('waiting').hidden = false;
  setTimeout(() => { $('waiting').hidden = true; $('incall').hidden = false; report('admitted', true);
    setTimeout(() => $('a').play().then(() => report('playing', true), err => report('play_error', String(err))), 4000); }, 2500);
};
$('a').onended = () => setTimeout(() => { report('ended', true); $('incall').hidden = true; $('end').hidden = false; }, 3000);
$('leave').onclick = e => report('leave', e.isTrusted);
</script></body></html>"#;

async fn fake_meet(seen: Arc<Mutex<Vec<Value>>>) -> String {
    let audio = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/speech.ogg"
    ))
    .unwrap();
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
        .route("/{code}", get(|| async { axum::response::Html(PAGE) }));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runner_container_attends_records_and_delivers() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE (and CAP_TEST_DATABASE_URL) to run the runner end to end");
        return;
    };
    let transcription = match std::env::var("CAP_TEST_WHISPER_MODEL") {
        Ok(model) => TranscriptionConfig::LocalWhisper {
            model_path: model.into(),
            threads: 4,
            language: Some("en".into()),
        },
        Err(_) => TranscriptionConfig::TestFixture,
    };
    let real_whisper = matches!(transcription, TranscriptionConfig::LocalWhisper { .. });
    let Some(w) = World::new(transcription).await else {
        return;
    };
    let acme = Uuid::new_v4();
    w.staff("cldon000000000000000000001", "don@calari.test");
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in("cldon000000000000000000001").await;
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

    let seen = Arc::new(Mutex::new(Vec::new()));
    let meet = fake_meet(seen.clone()).await;
    let name = format!("cap-bot-e2e-{}", Uuid::new_v4().simple());
    let _guard = Container(name.clone());
    let started = std::time::Instant::now();
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
            "-e",
            &format!("CAP_SERVER_URL={}", w.cap),
            "-e",
            "CAP_BOT_ALLOW_HTTP=1",
            "-e",
            "CAP_BOT_ENABLED=1",
            "-e",
            &format!("CAP_BOT_RUNNER_TOKEN={BOT_TOKEN}"),
            "-e",
            &format!("CAP_BOT_TEST_MEET_ORIGIN={meet}"),
            "-e",
            "CAP_BOT_HEARTBEAT_SECONDS=5",
            "-e",
            "CAP_BOT_WAITING_SECONDS=60",
            &image,
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Wait for the runner to finish the attendance.
    let mut state = String::new();
    for _ in 0..180 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        state = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
            .bind(att)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
        if state == "completed" || state == "failed" {
            break;
        }
    }
    let logs = Command::new("docker")
        .args(["logs", &name])
        .output()
        .unwrap();
    eprintln!(
        "runner log:\n{}{}",
        String::from_utf8_lossy(&logs.stdout),
        String::from_utf8_lossy(&logs.stderr)
    );
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

    // Transcribe and deliver.
    let t = std::time::Instant::now();
    while worker::run_once(&w.state, Utc::now()).await.unwrap() {}
    eprintln!("transcribed and delivered in {:?}", t.elapsed());
    {
        let c = w.calari.lock().unwrap();
        assert_eq!(c.bad_signatures, 0);
        assert_eq!(c.deliveries.len(), 1);
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
    let receipt: Option<String> =
        sqlx::query_scalar("SELECT receipt_id FROM meeting_deliveries WHERE status = 'delivered'")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    eprintln!("Calari receipt: {receipt:?}");
    assert!(receipt.is_some());
    // The bot's device is revoked once the attendance is done.
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let revoked: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_devices WHERE device_kind = 'calendar_bot' AND revoked_at IS NOT NULL").fetch_one(&w.state.db).await.unwrap();
    assert_eq!(revoked, 1);
    w.drop_db().await;
}
