//! Meetings library signed in through a stand-in Calari that checks the
//! signed exchange and status calls the way the real one must. Needs
//! `CAP_TEST_DATABASE_URL`.

#![allow(clippy::unwrap_used)]

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::post,
    Router,
};
use cap_meeting_protocol::{ids, pkce_s256, signing, LoginExchangeRequest, LoginStatusRequest};
use cap_server::{
    config::{Config, Integration, Secret, StorageConfig, TranscriptionConfig},
    router, AppState,
};
use chrono::Utc;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: [u8; 32] = [11; 32];
const TENANT: &str = "00000000-0000-4000-8000-000000000001";
const STAFF: &str = "clx8n2k0q0000abcd1234efgh";

#[derive(Default)]
struct FakeCalari {
    /// code -> (challenge, redirect_uri)
    codes: HashMap<String, (String, String)>,
    active: bool,
    status_broken: bool,
    /// Role Calari's status endpoint reports ("admin" or "staff").
    status_role: String,
    /// Role the exchange endpoint reports.
    exchange_role: String,
    tenant: String,
    exchanges: usize,
    status_calls: usize,
}

type Shared = Arc<Mutex<FakeCalari>>;

fn verified(headers: &axum::http::HeaderMap, body: &[u8]) -> bool {
    let h = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    };
    signing::verify(
        &SECRET,
        signing::Purpose::Login,
        &h(signing::HEADER_TIMESTAMP),
        &h(signing::HEADER_NONCE),
        &h(signing::HEADER_SIGNATURE),
        body,
        Utc::now().timestamp(),
    )
    .is_ok()
}

async fn spawn_calari(shared: Shared) -> String {
    let ex = shared.clone();
    let st = shared.clone();
    let app = Router::new()
        .route(
            "/exchange",
            post(move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let shared = ex.clone();
                async move {
                    if !verified(&headers, &body) {
                        return (StatusCode::UNAUTHORIZED, "bad signature".to_owned());
                    }
                    let req: LoginExchangeRequest = serde_json::from_slice(&body).unwrap();
                    let mut c = shared.lock().unwrap();
                    c.exchanges += 1;
                    match c.codes.remove(&req.code) {
                        Some((challenge, redirect)) if challenge == pkce_s256(&req.code_verifier) && redirect == req.redirect_uri => (
                            StatusCode::OK,
                            json!({"tenant_id": c.tenant, "user_id": STAFF, "email": "Clare@Calari.Example",
                                   "display_name": "Clare <b>", "role": c.exchange_role})
                            .to_string(),
                        ),
                        _ => (StatusCode::BAD_REQUEST, json!({"error": "invalid_grant"}).to_string()),
                    }
                }
            }),
        )
        .route(
            "/status",
            post(move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let shared = st.clone();
                async move {
                    if !verified(&headers, &body) {
                        return (StatusCode::UNAUTHORIZED, "bad signature".to_owned());
                    }
                    let req: LoginStatusRequest = serde_json::from_slice(&body).unwrap();
                    let mut c = shared.lock().unwrap();
                    c.status_calls += 1;
                    if c.status_broken {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "down".to_owned());
                    }
                    (
                        StatusCode::OK,
                        json!({"tenant_id": TENANT, "user_id": req.user_id, "email": "clare@calari.example", "display_name": "Clare <b>", "role": c.status_role, "active": c.active})
                        .to_string(),
                    )
                }
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

struct H {
    state: AppState,
    calari: Shared,
    admin_url: String,
    db: String,
}

impl H {
    async fn new() -> Option<Self> {
        let Ok(admin_url) = std::env::var("CAP_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set CAP_TEST_DATABASE_URL");
            return None;
        };
        let db = format!("l_{}", Uuid::new_v4().simple());
        let admin = sqlx::PgPool::connect(&admin_url).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {db}"))
            .execute(&admin)
            .await
            .unwrap();
        let calari: Shared = Arc::new(Mutex::new(FakeCalari {
            active: true,
            tenant: TENANT.into(),
            status_role: "admin".into(),
            exchange_role: "admin".into(),
            ..Default::default()
        }));
        let base = spawn_calari(calari.clone()).await;
        let cfg = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_url: Secret(format!("{}/{db}", admin_url.rsplit_once('/').unwrap().0)),
            storage: StorageConfig::Filesystem {
                root: std::env::temp_dir().join(format!("cap-lib-{db}")),
            },
            public_base_url: "http://cap.test".into(),
            production: false,
            trusted_proxy_hops: 0,
            integrations: vec![Integration {
                key_id: "calari-test".into(),
                tenant_id: TENANT.into(),
                secret: SECRET.to_vec(),
                delivery_url: format!("{base}/deliver"),
                login_authorize_url: Some("https://calari.test/portal/cap/authorize".into()),
                login_exchange_url: Some(format!("{base}/exchange")),
                login_status_url: Some(format!("{base}/status")),
            }],
            transcription: TranscriptionConfig::TestFixture,
            abandon_after: Duration::from_secs(3600),
            worker_interval: Duration::from_millis(50),
            site_dir: None,
            ffmpeg_path: "ffmpeg".into(),
        };
        let state = AppState::new(cfg).await.unwrap();
        Some(Self {
            state,
            calari,
            admin_url,
            db,
        })
    }

    async fn call(&self, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
        let res = router(self.state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = String::from_utf8_lossy(&to_bytes(res.into_body(), 4 << 20).await.unwrap())
            .into_owned();
        (status, headers, body)
    }

    async fn get(
        &self,
        path: &str,
        cookie: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        let mut b = Request::get(path);
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        self.call(b.body(Body::empty()).unwrap()).await
    }

    /// Starts a sign-in: returns the browser-binding cookie and Calari's query.
    async fn begin_login(&self, cookie: Option<&str>) -> (String, HashMap<String, String>) {
        let (s, h, _) = self.get("/login", cookie).await;
        assert_eq!(s, StatusCode::SEE_OTHER);
        let location = reqwest::Url::parse(h[header::LOCATION].to_str().unwrap()).unwrap();
        assert!(
            location
                .as_str()
                .starts_with("https://calari.test/portal/cap/authorize?"),
            "{location}"
        );
        let login_cookie = h
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .find(|c| c.starts_with("cap_login="))
            .expect("login cookie");
        assert!(login_cookie.contains("HttpOnly") && login_cookie.contains("SameSite=Lax"));
        let q: HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], "http://cap.test/auth/calari/callback");
        (login_cookie.split(';').next().unwrap().to_owned(), q)
    }

    /// Plays Calari: issues a code bound to that attempt's challenge.
    fn issue_code(&self, q: &HashMap<String, String>) -> String {
        let code = ids::random_token(32);
        self.calari.lock().unwrap().codes.insert(
            code.clone(),
            (q["code_challenge"].clone(), q["redirect_uri"].clone()),
        );
        code
    }

    async fn callback(
        &self,
        code: &str,
        state: &str,
        cookie: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        self.get(
            &format!("/auth/calari/callback?code={code}&state={state}"),
            cookie,
        )
        .await
    }

    /// Runs /login, plays Calari's part, and returns the session cookie.
    async fn sign_in(&self) -> String {
        let (login_cookie, q) = self.begin_login(None).await;
        let code = self.issue_code(&q);
        let (s, h, body) = self.callback(&code, &q["state"], Some(&login_cookie)).await;
        assert_eq!(s, StatusCode::SEE_OTHER, "{body}");
        assert_eq!(h[header::LOCATION], "/meetings");
        let cookie = h
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .find(|c| c.starts_with("cap_web="))
            .expect("session cookie");
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
        cookie.split(';').next().unwrap().to_owned()
    }

    async fn drop_db(self) {
        self.state.db.close().await;
        let admin = sqlx::PgPool::connect(&self.admin_url).await.unwrap();
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.db))
            .execute(&admin)
            .await
            .unwrap();
    }
}

/// A meeting with one stored part, created directly in the database.
async fn seed_meeting(h: &H, tenant: &str, title: &str) -> Uuid {
    let db = &h.state.db;
    let pairing = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO meeting_pairings (id, key_id, request_id, request_sha256, tenant_id, pairing_kind, client_id, client_display_name, code_hash, expires_at)
         VALUES ($1, 'calari-test', $2, 'x', $3, 'staff_client', $4, 'Acme <Ltd>', $5, now() + interval '1 hour')",
    )
    .bind(pairing)
    .bind(Uuid::new_v4())
    .bind(tenant)
    .bind(Uuid::new_v4())
    .bind(ids::random_token(20))
    .execute(db)
    .await
    .unwrap();
    let token_hash = ids::random_token(20);
    sqlx::query("INSERT INTO meeting_devices (token_hash, pairing_id, device_name, device_kind, expires_at) VALUES ($1, $2, 'd', 'desktop', now() + interval '1 hour')")
        .bind(&token_hash)
        .bind(pairing)
        .execute(db)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO meeting_sessions (id, pairing_id, device_token_hash, idempotency_key, title, capture_mode, source, started_at, ended_at, state)
         VALUES ($1, $2, $3, 'k', $4, 'audio', 'desktop', now() - interval '10 minutes', now(), 'delivered')",
    )
    .bind(id)
    .bind(pairing)
    .bind(&token_hash)
    .bind(title)
    .execute(db)
    .await
    .unwrap();
    let key = format!("meetings/{tenant}/{id}/000000.ogg");
    h.state
        .store
        .put(&key, b"OggS-test-audio".to_vec(), "audio/ogg")
        .await
        .unwrap();
    sqlx::query("INSERT INTO meeting_chunks (meeting_id, seq, sha256, size_bytes, container, object_key, start_ms, duration_ms) VALUES ($1, 0, 'x', 15, 'ogg', $2, 0, 30000)")
        .bind(id)
        .bind(&key)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO meeting_transcripts (meeting_id, provider, model, segments, text, sha256) VALUES ($1, 'test', 'ggml-test', $2, 'Send the photos by Friday', 'x')")
        .bind(id)
        .bind(json!([{"index": 0, "start_ms": 1500, "end_ms": 4000, "text": "Send the photos by Friday"}]))
        .execute(db)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn staff_sign_in_through_calari_and_browse_meetings() {
    let Some(h) = H::new().await else { return };
    let mine = seed_meeting(&h, TENANT, "Kickoff <script>alert(1)</script>").await;
    let theirs = seed_meeting(
        &h,
        "00000000-0000-4000-8000-0000000000ff",
        "Other tenant meeting",
    )
    .await;

    let (s, hd, _) = h.get("/meetings", None).await;
    assert_eq!(
        (s, hd[header::LOCATION].to_str().unwrap()),
        (StatusCode::SEE_OTHER, "/login"),
        "signed-out visitors go to sign-in"
    );

    let cookie = h.sign_in().await;
    let (s, hd, list) = h.get("/meetings", Some(&cookie)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(
        list.contains("Kickoff &lt;script&gt;"),
        "titles are escaped"
    );
    assert!(!list.contains("<script>alert"));
    assert!(
        !list.contains("Other tenant meeting"),
        "only this tenant's meetings"
    );
    assert!(
        list.contains("Clare &lt;b&gt;"),
        "Calari display name, escaped"
    );
    assert_eq!(hd[header::CACHE_CONTROL], "no-store");
    assert_eq!(hd[header::REFERRER_POLICY], "no-referrer");
    assert!(hd[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("script-src 'self'"));

    let (s, _, search) = h.get("/meetings?q=photos", Some(&cookie)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(search.contains("Kickoff"), "transcript text is searchable");

    let (s, _, page) = h.get(&format!("/meetings/{mine}"), Some(&cookie)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(page.contains("Send the photos by Friday") && page.contains("data-seek=\"1500\""));
    assert!(page.contains(&format!("/meetings/{mine}/parts/0")));
    let (s, hd, bytes) = h
        .get(&format!("/meetings/{mine}/parts/0"), Some(&cookie))
        .await;
    assert_eq!(
        (
            s,
            hd[header::CONTENT_TYPE].to_str().unwrap(),
            bytes.as_str()
        ),
        (StatusCode::OK, "audio/ogg", "OggS-test-audio")
    );

    assert_eq!(
        h.get(&format!("/meetings/{theirs}"), Some(&cookie)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.get(&format!("/meetings/{theirs}/parts/0"), Some(&cookie))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.get("/meetings", Some("cap_web=forged")).await.0,
        StatusCode::SEE_OTHER
    );
    h.drop_db().await;
}

#[tokio::test]
async fn sign_in_codes_and_states_are_single_use_and_bound() {
    let Some(h) = H::new().await else { return };
    let (cookie, q) = h.begin_login(None).await;
    // A code Calari issued for a different challenge is refused.
    h.calari.lock().unwrap().codes.insert(
        "c1".into(),
        (pkce_s256(&ids::random_token(64)), q["redirect_uri"].clone()),
    );
    let (s, hd, _) = h.callback("c1", &q["state"], Some(&cookie)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(!hd
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|c| c.to_str().unwrap().starts_with("cap_web=")));
    // The state was consumed: replaying it fails even with a good code.
    let c2 = h.issue_code(&q);
    assert_eq!(
        h.callback(&c2, &q["state"], Some(&cookie)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.callback(&c2, "made-up", Some(&cookie)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.get("/auth/calari/callback?error=access_denied", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // A staff member of another tenant is refused.
    h.calari.lock().unwrap().tenant = "00000000-0000-4000-8000-0000000000ff".into();
    let (cookie, q) = h.begin_login(None).await;
    let c3 = h.issue_code(&q);
    let (s, _, body) = h.callback(&c3, &q["state"], Some(&cookie)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(body.contains("does not belong"));
    h.drop_db().await;
}

/// Review P1 (login CSRF): an attacker who starts a sign-in and hands the
/// unused callback link to someone else cannot sign them in, and the link
/// is not spoiled for the browser that really started it.
#[tokio::test]
async fn a_sign_in_without_a_cap_role_is_refused() {
    let Some(h) = H::new().await else { return };
    h.calari.lock().unwrap().exchange_role = "none".into();
    let (login_cookie, q) = h.begin_login(None).await;
    let code = h.issue_code(&q);
    let (s, hd, _) = h.callback(&code, &q["state"], Some(&login_cookie)).await;
    assert_ne!(s, StatusCode::SEE_OTHER);
    assert!(hd
        .get_all(header::SET_COOKIE)
        .iter()
        .all(|c| !c.to_str().unwrap().starts_with("cap_web=")));
    let saved: i64 = sqlx::query_scalar("SELECT count(*) FROM cap_web_sessions")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(saved, 0);
    h.drop_db().await;
}

#[tokio::test]
async fn a_callback_link_only_works_in_the_browser_that_started_it() {
    let Some(h) = H::new().await else { return };
    let (attacker_cookie, q) = h.begin_login(None).await;
    let code = h.issue_code(&q);
    // Victim's browser: no attempt cookie, or another attempt's cookie.
    let (s, hd, _) = h.callback(&code, &q["state"], None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(!hd
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|c| c.to_str().unwrap().starts_with("cap_web=")));
    let (other_cookie, _) = h.begin_login(None).await;
    assert_eq!(
        h.callback(&code, &q["state"], Some(&other_cookie)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.calari.lock().unwrap().exchanges,
        0,
        "nothing was exchanged for the wrong browser"
    );
    // The browser that started it still succeeds, exactly once.
    let (s, _, body) = h.callback(&code, &q["state"], Some(&attacker_cookie)).await;
    assert_eq!(s, StatusCode::SEE_OTHER, "{body}");
    assert_eq!(
        h.callback(&code, &q["state"], Some(&attacker_cookie))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    h.drop_db().await;
}

/// Review P1 (idle loop): an idle session cookie leads to a fresh Calari
/// sign-in, not back to /meetings.
#[tokio::test]
async fn an_idle_cookie_starts_a_fresh_sign_in() {
    let Some(h) = H::new().await else { return };
    let cookie = h.sign_in().await;
    sqlx::query("UPDATE cap_web_sessions SET last_seen_at = now() - interval '61 minutes'")
        .execute(&h.state.db)
        .await
        .unwrap();
    assert_eq!(
        h.get("/meetings", Some(&cookie)).await.0,
        StatusCode::SEE_OTHER
    );
    let _ = h.begin_login(Some(&cookie)).await; // asserts a redirect to Calari, not /meetings
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM cap_web_sessions")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0, "the idle session was removed");
    h.drop_db().await;
}

#[tokio::test]
async fn every_request_is_checked_with_calari_and_fails_closed() {
    let Some(h) = H::new().await else { return };
    let id = seed_meeting(&h, TENANT, "Kickoff").await;
    let cookie = h.sign_in().await;
    assert_eq!(h.get("/meetings", Some(&cookie)).await.0, StatusCode::OK);
    assert_eq!(
        h.get(&format!("/meetings/{id}/parts/0"), Some(&cookie))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        h.calari.lock().unwrap().status_calls,
        2,
        "one Calari check per protected request, no cache"
    );

    // Calari unreachable: no access, but the session survives for later.
    h.calari.lock().unwrap().status_broken = true;
    let (s, _, body) = h.get("/meetings", Some(&cookie)).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("could not check"));
    assert_eq!(
        h.get(&format!("/meetings/{id}/parts/0"), Some(&cookie))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE,
        "media too"
    );
    h.calari.lock().unwrap().status_broken = false;
    assert_eq!(h.get("/meetings", Some(&cookie)).await.0, StatusCode::OK);

    // Until Calari defines staff scope, only admins see meetings.
    h.calari.lock().unwrap().status_role = "staff".into();
    let (s, _, body) = h.get("/meetings", Some(&cookie)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(body.contains("not available to your account"));
    assert_eq!(
        h.get(&format!("/meetings/{id}"), Some(&cookie)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        h.get(&format!("/meetings/{id}/parts/0"), Some(&cookie))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    h.calari.lock().unwrap().status_role = "admin".into();

    // Offboarded in Calari (its exact answer: role "none", not active): the very next
    // request ends the session.
    h.calari.lock().unwrap().active = false;
    h.calari.lock().unwrap().status_role = "none".into();
    let (s, hd, _) = h
        .get(&format!("/meetings/{id}/parts/0"), Some(&cookie))
        .await;
    assert_eq!(
        (s, hd[header::LOCATION].to_str().unwrap()),
        (StatusCode::SEE_OTHER, "/login")
    );
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM cap_web_sessions")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    h.drop_db().await;
}

#[tokio::test]
async fn idle_sessions_expire_and_sign_out_needs_the_form_token() {
    let Some(h) = H::new().await else { return };
    let cookie = h.sign_in().await;
    let (_, _, page) = h.get("/meetings", Some(&cookie)).await;
    let csrf = page
        .split("name=\"csrf\" value=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_owned();
    let logout = |token: &str| {
        Request::post("/logout")
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(format!("csrf={token}")))
            .unwrap()
    };
    assert_eq!(h.call(logout("wrong")).await.0, StatusCode::FORBIDDEN);
    let (s, hd, _) = h.call(logout(&csrf)).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert!(hd[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        h.get("/meetings", Some(&cookie)).await.0,
        StatusCode::SEE_OTHER
    );

    let again = h.sign_in().await;
    sqlx::query("UPDATE cap_web_sessions SET last_seen_at = now() - interval '61 minutes'")
        .execute(&h.state.db)
        .await
        .unwrap();
    assert_eq!(
        h.get("/meetings", Some(&again)).await.0,
        StatusCode::SEE_OTHER,
        "idle for over an hour"
    );
    h.drop_db().await;
}
