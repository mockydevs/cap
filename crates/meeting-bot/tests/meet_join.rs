//! The join loop against local stand-in pages in a real Chrome: a refusal is
//! told apart from a page that never offered a join button, and what is
//! reported is fixed vocabulary only (no page text, URLs or tokens).
//! Opt-in: CAP_TEST_CHROME=google-chrome cargo test -p cap-meeting-bot --test meet_join

#![allow(clippy::unwrap_used)]

use axum::{extract::Query, routing::get, Router};
use cap_meeting_bot::{
    cdp,
    meet::{self, JoinOutcome, RefusalReason},
};
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;

const SECRET: &str = "SECRET-MARKER-7f3a";

fn page(kind: &str) -> String {
    let body = match kind {
        "cant-join" => format!("<h1>You can’t join this video call</h1><p>{SECRET}</p><button>Return to home screen</button>"),
        // Still loading (a blocked script never arrives), a join-like button
        // that is not the one the bot knows, and private text.
        "no-button" => format!(
            r#"<title>{SECRET}</title><p>Getting ready…</p><p>{SECRET} is in this call</p>
               <button>Join with companion mode</button>
               <script src="http://blocked.invalid/app.js?token={SECRET}"></script>"#
        ),
        // The name is typed, but Meet keeps "Ask to join" disabled.
        "disabled" => r#"<input type="text" aria-label="Your name"><button disabled>Ask to join</button>"#.into(),
        // Asks, waits, then the host denies.
        "denied" => r#"<input type="text" aria-label="Your name" id="n">
            <button id="j">Ask to join</button><div id="w" hidden>Asking to be let in…</div>
            <script>document.getElementById('j').onclick = () => {
              document.getElementById('j').remove(); document.getElementById('w').hidden = false;
              setTimeout(() => { document.body.innerHTML = '<p>Someone in the call denied your request to join</p>'; }, 1500);
            };</script>"#.into(),
        // A media prompt that never goes away, and a name box that clears
        // itself: the page-load limit must still end the attempt.
        "sticky" => r#"<button id="m">Continue without microphone and camera</button>
            <input type="text" aria-label="Your name" id="n">
            <script>setInterval(() => { document.getElementById('n').value = ''; }, 100);</script>"#.into(),
        _ => String::new(),
    };
    format!(
        "<!doctype html><html lang=en><head><meta charset=utf-8></head><body>{body}</body></html>"
    )
}

async fn serve() -> String {
    let app = Router::new().route(
        "/{code}",
        get(|Query(q): Query<HashMap<String, String>>| async move {
            axum::response::Html(page(q.get("k").map_or("", String::as_str)))
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

fn attempt(chrome: &str, url: String) -> JoinOutcome {
    let profile =
        std::env::temp_dir().join(format!("cap-meet-join-{}", uuid::Uuid::new_v4().simple()));
    let mut b = cdp::Browser::launch(cdp::LaunchOptions {
        chrome,
        profile,
        pulse_sink: "unused",
        pulse_source: None,
        no_sandbox: false,
        headless: true,
    })
    .unwrap();
    // Stands in for the URL policy (production: ERR_BLOCKED_BY_ADMINISTRATOR);
    // the browser already watches the network.
    b.command(
        "Network.setBlockedURLs",
        json!({"urls": ["*blocked.invalid*"]}),
    )
    .unwrap();
    let keep = || true;
    let mut on_waiting = || {};
    meet::join(
        &mut b,
        &url,
        meet::JoinOptions {
            display_name: "Calari Notetaker",
            page_load_timeout: Duration::from_secs(4),
            waiting_timeout: Duration::from_secs(20),
            on_waiting: &mut on_waiting,
            keep_going: &keep,
            mute_microphone: true,
        },
    )
    .unwrap()
}

fn assert_safe(text: &str, base: &str) {
    let port = base.rsplit(':').next().unwrap();
    for leak in [
        SECRET,
        "127.0.0.1",
        port,
        "blocked.invalid",
        "abc-defg-hij",
        "http",
    ] {
        assert!(!text.contains(leak), "{leak:?} leaked into {text:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refusal_timeout_disabled_and_denied_are_told_apart() {
    let Ok(chrome) = std::env::var("CAP_TEST_CHROME") else {
        eprintln!("SKIPPED: set CAP_TEST_CHROME");
        return;
    };
    let base = serve().await;
    let run = |kind: &'static str| {
        let (chrome, url) = (chrome.clone(), format!("{base}/abc-defg-hij?k={kind}"));
        tokio::task::spawn_blocking(move || attempt(&chrome, url))
    };
    let (cant, none, disabled, denied) = tokio::join!(
        run("cant-join"),
        run("no-button"),
        run("disabled"),
        run("denied")
    );

    // 1. Meet's own refusal: a reason code, before asking.
    let JoinOutcome::Refused { reason, diag } = cant.unwrap() else {
        panic!("cant-join")
    };
    eprintln!("cant-join: {reason:?} {diag}");
    assert_eq!(reason, RefusalReason::CantJoin);
    assert_eq!(
        (diag.page, diag.asked, diag.waited),
        ("meet/code", false, false)
    );
    assert!(diag.flags.contains(&"return_home"));
    assert_safe(&diag.to_string(), &base);

    // 2. No join button: not a refusal; what the page looked like, safely.
    let JoinOutcome::NoJoinButton(diag) = none.unwrap() else {
        panic!("no-button")
    };
    let shown = diag.to_string();
    eprintln!("no-button: {shown}");
    assert_eq!(
        (diag.page, diag.join, diag.asked),
        ("meet/code", "none", false)
    );
    for f in ["getting_ready", "join_variant", "someone_in_call"] {
        assert!(diag.flags.contains(&f), "{f} in {shown}");
    }
    assert_eq!(diag.net.blocked.get("other"), Some(&1), "{shown}");
    assert!(diag.secs >= 4);
    assert_safe(&shown, &base);

    // 3. A disabled "Ask to join" is not asking (old code clicked it, then
    //    waited the whole admission limit for nobody).
    let JoinOutcome::NoJoinButton(diag) = disabled.unwrap() else {
        panic!("disabled")
    };
    eprintln!("disabled: {diag}");
    assert_eq!(
        (diag.name, diag.join, diag.asked),
        ("filled", "disabled", false)
    );

    // 4. Asked, waited, then the host said no.
    let JoinOutcome::Refused { reason, diag } = denied.unwrap() else {
        panic!("denied")
    };
    eprintln!("denied: {reason:?} {diag}");
    assert_eq!(reason, RefusalReason::Denied);
    assert_eq!((diag.asked, diag.waited), (true, true));
    assert_safe(&diag.to_string(), &base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_load_limit_holds_against_a_persistent_prompt() {
    let Ok(chrome) = std::env::var("CAP_TEST_CHROME") else {
        eprintln!("SKIPPED: set CAP_TEST_CHROME");
        return;
    };
    let base = serve().await;
    let url = format!("{base}/abc-defg-hij?k=sticky");
    let started = std::time::Instant::now();
    // Limit 4 s; anything past 20 s means the deadline was bypassed (the
    // blocking attempt is then abandoned with the test).
    let out = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || attempt(&chrome, url)),
    )
    .await
    .expect("join kept acting past its page-load limit")
    .unwrap();
    let JoinOutcome::NoJoinButton(diag) = out else {
        panic!("sticky: {out:?}")
    };
    eprintln!("sticky: {diag} after {:?}", started.elapsed());
    assert!(!diag.asked);
    assert!((4..=6).contains(&diag.secs), "{diag}");
}
