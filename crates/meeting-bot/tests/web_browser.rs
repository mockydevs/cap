//! The staff pages in a real browser: Chromium enforces Referrer-Policy and
//! CSP the way production users see them (the request-level tests do not).
//! Opt-in: CAP_TEST_DATABASE_URL=… CAP_TEST_CHROME=google-chrome \
//!   cargo test -p cap-meeting-bot --features fake-meet --test web_browser

#![allow(clippy::unwrap_used)]

mod support;

use cap_meeting_bot::cdp;
use serde_json::json;
use support::*;

fn wait_for_url(b: &mut cdp::Browser, pred: impl Fn(&str) -> bool) -> String {
    let mut url = String::new();
    for _ in 0..50 {
        url = b
            .eval("location.href")
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        if pred(&url) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    url
}

fn wait_loaded(b: &mut cdp::Browser) {
    for _ in 0..100 {
        if b.eval("document.readyState")
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .as_deref()
            == Some("complete")
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn click_button(b: &mut cdp::Browser, text: &str) {
    wait_loaded(b);
    let js = format!(
        r#"(() => {{ const el = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === {text:?});
             if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()"#
    );
    let mut at = serde_json::Value::Null;
    for _ in 0..50 {
        at = b.eval(&js).unwrap();
        if !at.is_null() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let x = at[0]
        .as_f64()
        .unwrap_or_else(|| panic!("no button {text:?}"));
    b.click(x, at[1].as_f64().unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn calendar_connect_and_sign_out_work_in_a_real_browser() {
    let Ok(chrome) = std::env::var("CAP_TEST_CHROME") else {
        eprintln!("SKIPPED: set CAP_TEST_CHROME (and CAP_TEST_DATABASE_URL)");
        return;
    };
    let Some(w) = World::with_local_google_auth(TranscriptionConfig::TestFixture).await else {
        return;
    };
    w.staff(DON, "don@calari.test");
    let s = w.seed_session(DON, "don@calari.test", false).await;
    let token = s.cookie.split_once('=').unwrap().1.to_owned();
    let cap = w.cap.clone();
    let result = tokio::task::spawn_blocking(move || {
        let profile = std::env::temp_dir().join(format!("cap-web-{}", Uuid::new_v4().simple()));
        let mut b = cdp::Browser::launch(cdp::LaunchOptions {
            chrome: &chrome,
            profile,
            pulse_sink: "unused",
            pulse_source: None,
            no_sandbox: false,
            headless: true,
        })
        .unwrap();
        b.command("Network.enable", json!({})).unwrap();
        b.command("Network.setCookie", json!({"name": "cap_web", "value": token, "url": cap, "httpOnly": true, "sameSite": "Lax"}))
            .unwrap();
        b.navigate(&format!("{cap}/calendar")).unwrap();
        click_button(&mut b, "Connect Google Calendar");
        let after_connect = wait_for_url(&mut b, |u| u.contains("/o/oauth2/v2/auth"));
        let title = b.eval("document.title").unwrap();
        b.navigate(&format!("{cap}/calendar")).unwrap();
        click_button(&mut b, "Sign out");
        let after_logout = wait_for_url(&mut b, |u| u.ends_with("/login/signed-out"));
        (after_connect, title, after_logout)
    })
    .await
    .unwrap();
    eprintln!(
        "after Connect: {} ({}); after Sign out: {}",
        result.0, result.1, result.2
    );
    assert!(
        result.0.contains("/o/oauth2/v2/auth?"),
        "Connect reached Google's consent: {}",
        result.0
    );
    assert!(result.0.contains("code_challenge_method=S256"));
    assert_eq!(result.1, "Fake Google consent");
    assert!(
        result.2.ends_with("/login/signed-out"),
        "Sign out worked: {}",
        result.2
    );
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_oauth_attempts")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
    w.drop_db().await;
}
