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

mod support;

use support::*;

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

/// Review round 2: the lobby's "waiting" report hangs. The control thread
/// must not block on it; the runner leaves (browser gone) before the server's
/// lease ends, and never records.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hung_waiting_report_leaves_before_server_lease() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE");
        return;
    };
    const LEASE: i64 = 20;
    let Some((w, _att, _acme, _real)) = ready_world(LEASE).await else {
        return;
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let alive = Arc::new(AtomicU64::new(0));
    // Nobody admits the bot for two minutes.
    let meet = fake_meet_with(seen.clone(), true, 120_000, alive.clone()).await;
    let (p, server) = proxy(&w.cap).await;
    p.hang_states.lock().unwrap().push("waiting".into());
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let c = start_runner(&image, &server, &meet, &volume.0);
    for _ in 0..90 {
        if seen.lock().unwrap().iter().any(|v| v["k"] == "join") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    assert!(
        seen.lock().unwrap().iter().any(|v| v["k"] == "join"),
        "{}",
        logs(&c)
    );
    tokio::time::sleep(std::time::Duration::from_secs((LEASE as u64) + 15)).await;
    eprintln!("runner log:\n{}", logs(&c));
    let last_ok = *p.reports_ok.lock().unwrap().iter().max().unwrap();
    let lease_end = last_ok + (LEASE as u128) * 1000;
    let last_alive = alive.load(Ordering::SeqCst) as u128;
    eprintln!(
        "waiting phase: last confirmed report {last_ok}, browser last alive {last_alive} ({} ms later), server lease ends {lease_end}",
        last_alive.saturating_sub(last_ok)
    );
    assert!(last_alive > 0);
    assert!(
        last_alive < lease_end,
        "browser gone before the server lease ended"
    );
    let meetings: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_sessions")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(meetings, 0, "never recorded");
    drop(c);
    w.drop_db().await;
}

/// Review round 2: the first "recording" report (right after capture starts)
/// hangs. Capture and browser must still stop before the server lease ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hung_first_recording_report_stops_capture_before_server_lease() {
    let Ok(image) = std::env::var("CAP_TEST_BOT_IMAGE") else {
        eprintln!("SKIPPED: set CAP_TEST_BOT_IMAGE");
        return;
    };
    const LEASE: i64 = 20;
    let Some((w, _att, acme, _real)) = ready_world(LEASE).await else {
        return;
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let alive = Arc::new(AtomicU64::new(0));
    let meet = fake_meet_with(seen.clone(), true, 2_500, alive.clone()).await;
    let (p, server) = proxy(&w.cap).await;
    p.hang_states.lock().unwrap().push("recording".into());
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let c = start_runner(&image, &server, &meet, &volume.0);
    let mut created = false;
    for _ in 0..240 {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_sessions")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
        if n > 0 {
            created = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert!(created, "{}", logs(&c));
    tokio::time::sleep(std::time::Duration::from_secs((LEASE as u64) + 20)).await;
    eprintln!("runner log:\n{}", logs(&c));
    let last_ok = *p.reports_ok.lock().unwrap().iter().max().unwrap();
    let lease_end = last_ok + (LEASE as u128) * 1000;
    let last_alive = alive.load(Ordering::SeqCst) as u128;
    eprintln!(
        "recording phase: last confirmed report {last_ok}, browser last alive {last_alive} ({} ms later), server lease ends {lease_end}",
        last_alive.saturating_sub(last_ok)
    );
    assert!(
        last_alive < lease_end,
        "browser gone before the server lease ended"
    );
    let (ended, mstate): (Option<chrono::DateTime<Utc>>, String) =
        sqlx::query_as("SELECT ended_at, state FROM meeting_sessions")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_ne!(mstate, "recording", "finalized by the runner");
    let ended_ms = ended.unwrap().timestamp_millis() as u128;
    assert!(
        ended_ms <= lease_end,
        "audio ends {ended_ms} <= lease end {lease_end}"
    );
    let joins = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["k"] == "join")
        .count();
    assert_eq!(joins, 1);
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let meetings: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_sessions")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(meetings, 1, "not re-queued to a second recording");
    deliver(&w).await;
    {
        let c = w.calari.lock().unwrap();
        assert_eq!(c.deliveries.len(), 1);
        assert_eq!(c.deliveries[0]["client_id"], acme.to_string());
    }
    drop(c);
    w.drop_db().await;
}
