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
        Self::new_at("http://cap.test").await
    }

    async fn new_at(public_base_url: &str) -> Option<Self> {
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
            public_base_url: public_base_url.into(),
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
                calendar_resolve_url: None,
                calendar_pairing_url: None,
            }],
            transcription: TranscriptionConfig::TestFixture,
            abandon_after: Duration::from_secs(3600),
            empty_after: std::time::Duration::from_secs(48 * 3600),
            worker_interval: Duration::from_millis(50),
            download_dir: None,
            portal_url: None,
            ffmpeg_path: "ffmpeg".into(),
            calendar: None,
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
        assert_eq!(
            q["redirect_uri"],
            format!("{}/auth/calari/callback", self.state.cfg.public_base_url)
        );
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
    // same-origin, not no-referrer: Chromium sends `Origin: null` on our own
    // forms under no-referrer, which the Origin checks refuse.
    assert_eq!(hd[header::REFERRER_POLICY], "same-origin");
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

// ---------------------------------------------------------------------------
// Library edits: notes, display titles, archive/restore.
// ---------------------------------------------------------------------------

const OTHER_TENANT: &str = "00000000-0000-4000-8000-0000000000ff";

impl H {
    async fn post(
        &self,
        path: &str,
        cookie: &str,
        form: &[(&str, &str)],
        origin: Option<&str>,
    ) -> (StatusCode, axum::http::HeaderMap, String) {
        let body = form
            .iter()
            .map(|(k, v)| format!("{k}={}", urlencode(v)))
            .collect::<Vec<_>>()
            .join("&");
        let mut b = Request::post(path)
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        self.call(b.body(Body::from(body)).unwrap()).await
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Value of the first `name="<field>" value="…"` in a page.
fn field(page: &str, name: &str) -> String {
    page.split(&format!("name=\"{name}\" value=\""))
        .nth(1)
        .unwrap_or_else(|| panic!("no {name} field"))
        .split('"')
        .next()
        .unwrap()
        .to_owned()
}

/// Gives a seeded meeting a frozen Calari delivery, like the worker does.
async fn seed_delivery(h: &H, id: Uuid) {
    sqlx::query(
        "INSERT INTO meeting_deliveries (event_id, meeting_id, revision, key_id, delivery_url, body, body_sha256, status, attempts, receipt_id, delivered_at)
         VALUES ($1, $2, 1, 'calari-test', 'http://calari.test/deliver', $3, 'frozen-sha', 'delivered', 1, 'rcpt-1', now())",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(b"{\"frozen\":true}".to_vec())
    .execute(&h.state.db)
    .await
    .unwrap();
}

/// Everything the recorder and Calari delivery own, as one comparable string.
async fn recorded_snapshot(h: &H, id: Uuid) -> String {
    let r: (String, i32, String, String, String, String, i64) = sqlx::query_as(
        "SELECT m.title, m.revision, m.state, m.updated_at::text, t.segments::text || t.text || t.sha256,
                string_agg(encode(d.body, 'hex') || d.body_sha256 || d.status || d.attempts::text || coalesce(d.receipt_id, ''), ',' ORDER BY d.revision),
                count(d.*)
         FROM meeting_sessions m JOIN meeting_transcripts t ON t.meeting_id = m.id
         LEFT JOIN meeting_deliveries d ON d.meeting_id = m.id
         WHERE m.id = $1 GROUP BY m.id, t.meeting_id",
    )
    .bind(id)
    .fetch_one(&h.state.db)
    .await
    .unwrap();
    format!("{r:?}")
}

async fn note_count(h: &H, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM library_notes WHERE meeting_id = $1")
        .bind(id)
        .fetch_one(&h.state.db)
        .await
        .unwrap()
}

async fn note_ids(h: &H, id: Uuid) -> Vec<(Uuid, i32)> {
    sqlx::query_as(
        "SELECT id, version FROM library_notes WHERE meeting_id = $1 ORDER BY created_at",
    )
    .bind(id)
    .fetch_all(&h.state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn notes_can_be_added_edited_and_deleted_with_version_checks() {
    let Some(h) = H::new().await else { return };
    let id = seed_meeting(&h, TENANT, "Kickoff").await;
    seed_delivery(&h, id).await;
    let before = recorded_snapshot(&h, id).await;
    let cookie = h.sign_in().await;
    let page = format!("/meetings/{id}");
    let (s, _, html) = h.get(&page, Some(&cookie)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(html.contains("No notes yet"));
    let csrf = field(&html, "csrf");
    let key = field(&html, "submit_key");

    // Create, escaped on the way out.
    let add = |body: &'static str, key: String| {
        let csrf = csrf.clone();
        let cookie = cookie.clone();
        let h = &h;
        async move {
            h.post(
                &format!("/meetings/{id}/notes"),
                &cookie,
                &[("csrf", &csrf), ("submit_key", &key), ("body", body)],
                Some("http://cap.test"),
            )
            .await
        }
    };
    let (s, hd, _) = add("Follow up with <b>Acme</b>\r\nby Friday", key.clone()).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert!(hd[header::LOCATION]
        .to_str()
        .unwrap()
        .starts_with(&format!("/meetings/{id}?done=note_added#note-")));
    // The same form sent twice (double click, retry) makes one note.
    assert_eq!(
        add("Follow up with <b>Acme</b>\r\nby Friday", key).await.0,
        StatusCode::SEE_OTHER
    );
    assert_eq!(note_count(&h, id).await, 1);
    let (_, _, html) = h
        .get(&format!("{page}?done=note_added"), Some(&cookie))
        .await;
    assert!(html.contains("Follow up with &lt;b&gt;Acme&lt;/b&gt;\nby Friday"));
    assert!(!html.contains("<b>Acme"));
    assert!(html.contains("Note added."));
    assert!(
        html.contains("Clare &lt;b&gt;"),
        "author is the Calari display name"
    );
    assert!(html.contains(&format!("data-saved-draft=\"{id}.new\"")));

    // Empty and oversized notes are refused, and the oversized text is kept.
    let (s, _, _) = add("   \n ", Uuid::new_v4().to_string()).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    let long = "x".repeat(20_001);
    let (s, _, html) = h
        .post(
            &format!("/meetings/{id}/notes"),
            &cookie,
            &[
                ("csrf", &csrf),
                ("submit_key", &Uuid::new_v4().to_string()),
                ("body", &long),
            ],
            None,
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(html.contains(&long), "the user's text is not lost");
    assert_eq!(note_count(&h, id).await, 1);

    // Edit with the current version, then a stale edit is refused (409) with
    // the user's text kept and the saved text untouched.
    let (note, v) = note_ids(&h, id).await[0];
    assert_eq!(v, 1);
    let edit = |body: &str, version: &str| {
        let f = [
            ("csrf", csrf.as_str()),
            ("version", version),
            ("body", body),
        ];
        let path = format!("/meetings/{id}/notes/{note}");
        let cookie = cookie.clone();
        let f: Vec<(String, String)> = f
            .iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect();
        let h = &h;
        async move {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            h.post(&path, &cookie, &f, Some("http://cap.test")).await
        }
    };
    let (s, hd, _) = edit("Follow up with Acme by Thursday", "1").await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(
        hd[header::LOCATION].to_str().unwrap(),
        format!("/meetings/{id}?done=note_saved&note={note}#note-{note}")
    );
    let (s, _, html) = edit("My stale <i>rewrite</i>", "1").await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(html.contains("Someone else saved this note"));
    assert!(
        html.contains("My stale &lt;i&gt;rewrite&lt;/i&gt;"),
        "draft kept, escaped"
    );
    assert!(html.contains("by Thursday"), "current text shown");
    assert!(html.contains("data-server-draft"));
    let body: String = sqlx::query_scalar("SELECT body FROM library_notes WHERE id = $1")
        .bind(note)
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(body, "Follow up with Acme by Thursday");

    // Two editors at once on version 2: exactly one wins.
    let (a, b) = tokio::join!(edit("Editor A", "2"), edit("Editor B", "2"));
    let mut codes = [a.0, b.0];
    codes.sort();
    assert_eq!(codes, [StatusCode::SEE_OTHER, StatusCode::CONFLICT]);
    assert_eq!(note_ids(&h, id).await[0].1, 3);

    // Delete: stale version refused, current deletes, repeat is harmless.
    let del = |version: &str| {
        let path = format!("/meetings/{id}/notes/{note}/delete");
        let f = [
            ("csrf".to_owned(), csrf.clone()),
            ("version".to_owned(), version.to_owned()),
        ];
        let cookie = cookie.clone();
        let h = &h;
        async move {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            h.post(&path, &cookie, &f, None).await
        }
    };
    let (_, _, confirm) = h
        .get(&format!("{page}?confirm=delete&note={note}"), Some(&cookie))
        .await;
    assert!(confirm.contains("Delete this note?"));
    assert_eq!(del("2").await.0, StatusCode::CONFLICT);
    assert_eq!(note_count(&h, id).await, 1);
    let (s, hd, _) = del("3").await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert!(hd[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("done=note_deleted"));
    assert_eq!(note_count(&h, id).await, 0);
    let (s, hd, _) = del("3").await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert!(hd[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("note_already_deleted"));
    // Editing a note that was deleted keeps the text for a new note.
    let (s, _, html) = edit("Late edit", "3").await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(html.contains("was deleted while you were editing") && html.contains("Late edit"));

    // Audit trail without note text.
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM library_audit WHERE meeting_id = $1 ORDER BY id")
            .bind(id)
            .fetch_all(&h.state.db)
            .await
            .unwrap();
    assert_eq!(
        actions,
        ["note_add", "note_edit", "note_edit", "note_delete"]
    );

    assert_eq!(
        recorded_snapshot(&h, id).await,
        before,
        "recording and delivery untouched"
    );
    h.drop_db().await;
}

#[tokio::test]
async fn rename_archive_and_restore_never_touch_the_recording() {
    let Some(h) = H::new().await else { return };
    let id = seed_meeting(&h, TENANT, "Kickoff call").await;
    seed_delivery(&h, id).await;
    let live = seed_meeting(&h, TENANT, "Still recording").await;
    sqlx::query("UPDATE meeting_sessions SET state = 'recording', ended_at = NULL WHERE id = $1")
        .bind(live)
        .execute(&h.state.db)
        .await
        .unwrap();
    let before = recorded_snapshot(&h, id).await;
    let cookie = h.sign_in().await;
    let (_, _, html) = h.get(&format!("/meetings/{id}"), Some(&cookie)).await;
    let csrf = field(&html, "csrf");
    assert_eq!(field(&html, "version"), "0");
    let post = |path: String, f: Vec<(&'static str, String)>| {
        let cookie = cookie.clone();
        let h = &h;
        async move {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (*a, b.as_str())).collect();
            h.post(&path, &cookie, &f, Some("http://cap.test")).await
        }
    };
    let rename = |title: &str, v: &str| {
        post(
            format!("/meetings/{id}/title"),
            vec![
                ("csrf", csrf.clone()),
                ("version", v.into()),
                ("title", title.into()),
            ],
        )
    };

    let (s, hd, _) = rename("  Acme <kickoff>\n  ", "0").await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert!(hd[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("done=renamed"));
    let (_, _, list) = h.get("/meetings", Some(&cookie)).await;
    assert!(list.contains("Acme &lt;kickoff&gt;") && list.contains("Recorded as “Kickoff call”"));
    let (_, _, found) = h.get("/meetings?q=kickoff%3E", Some(&cookie)).await;
    assert!(
        found.contains("Acme &lt;kickoff&gt;"),
        "display titles are searchable"
    );
    // A second tab still on version 0 is told, and its title kept.
    let (s, _, html) = rename("Other tab title", "0").await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(html.contains("value=\"Other tab title\""));
    let (s, _, _) = rename(&"t".repeat(201), "1").await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    // Empty goes back to the recorded title.
    assert_eq!(rename("", "1").await.0, StatusCode::SEE_OTHER);
    let shown: Option<String> =
        sqlx::query_scalar("SELECT display_title FROM library_meetings WHERE meeting_id = $1")
            .bind(id)
            .fetch_one(&h.state.db)
            .await
            .unwrap();
    assert_eq!(shown, None);

    // Only finished meetings can be archived.
    let (_, _, lhtml) = h.get(&format!("/meetings/{live}"), Some(&cookie)).await;
    assert!(!lhtml.contains("confirm=archive"));
    let (s, _, html) = post(
        format!("/meetings/{live}/archive"),
        vec![("csrf", csrf.clone()), ("version", "0".into())],
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(html.contains("still being recorded"));

    // Archive asks first, then hides the meeting from the main list.
    let (_, _, confirm) = h
        .get(&format!("/meetings/{id}?confirm=archive"), Some(&cookie))
        .await;
    assert!(
        confirm.contains("Archive this meeting?") && confirm.contains("nothing is sent to Calari")
    );
    let archive = |v: &str| {
        post(
            format!("/meetings/{id}/archive"),
            vec![("csrf", csrf.clone()), ("version", v.into())],
        )
    };
    let (a, b) = tokio::join!(archive("2"), archive("2"));
    assert_eq!((a.0, b.0), (StatusCode::SEE_OTHER, StatusCode::SEE_OTHER));
    let mut locs = [
        a.1[header::LOCATION].to_str().unwrap().to_owned(),
        b.1[header::LOCATION].to_str().unwrap().to_owned(),
    ];
    locs.sort();
    assert!(
        locs[0].contains("done=already_archived") && locs[1].contains("done=archived"),
        "{locs:?}"
    );
    let (_, _, list) = h.get("/meetings", Some(&cookie)).await;
    assert!(!list.contains("Kickoff call") && list.contains("Still recording"));
    assert!(list.contains("Archived <span class=\"count\">1</span>"));
    let (_, _, arch) = h.get("/meetings?view=archived", Some(&cookie)).await;
    assert!(arch.contains("Kickoff call") && !arch.contains("Still recording"));

    // Archived: readable and playable, but notes and title are read-only.
    let (s, _, html) = h.get(&format!("/meetings/{id}"), Some(&cookie)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(html.contains("read-only until you restore") && !html.contains("name=\"submit_key\""));
    assert_eq!(
        h.get(&format!("/meetings/{id}/parts/0"), Some(&cookie))
            .await
            .0,
        StatusCode::OK,
        "archiving purges nothing"
    );
    let (s, _, html) = post(
        format!("/meetings/{id}/notes"),
        vec![
            ("csrf", csrf.clone()),
            ("submit_key", Uuid::new_v4().to_string()),
            ("body", "late note".into()),
        ],
    )
    .await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(html.contains("late note"), "kept for after restore");
    assert_eq!(note_count(&h, id).await, 0);
    assert_eq!(rename("While archived", "3").await.0, StatusCode::CONFLICT);

    // Restore brings it back.
    let (s, _, _) = post(
        format!("/meetings/{id}/restore"),
        vec![("csrf", csrf.clone()), ("version", "3".into())],
    )
    .await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    let (_, _, list) = h.get("/meetings", Some(&cookie)).await;
    assert!(list.contains("Kickoff call"));

    assert_eq!(
        recorded_snapshot(&h, id).await,
        before,
        "title, transcript and delivery unchanged"
    );
    let deliveries: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_deliveries")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(deliveries, 1, "no new delivery was queued");
    h.drop_db().await;
}

#[tokio::test]
async fn library_edits_are_refused_without_a_valid_form_role_or_tenant() {
    let Some(h) = H::new().await else { return };
    let mine = seed_meeting(&h, TENANT, "Mine").await;
    let theirs = seed_meeting(&h, OTHER_TENANT, "Theirs").await;
    // A note in the other tenant, which must never show up here.
    sqlx::query(
        "INSERT INTO library_notes (id, meeting_id, tenant_id, body, submit_key, created_by, created_by_name, updated_by, updated_by_name)
         VALUES ($1, $2, $3, 'other tenant secret plan', $4, 'u', 'U', 'u', 'U')",
    )
    .bind(Uuid::new_v4())
    .bind(theirs)
    .bind(OTHER_TENANT)
    .bind(Uuid::new_v4())
    .execute(&h.state.db)
    .await
    .unwrap();
    let their_note: Uuid = sqlx::query_scalar("SELECT id FROM library_notes WHERE meeting_id = $1")
        .bind(theirs)
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    let cookie = h.sign_in().await;
    let (_, _, html) = h.get(&format!("/meetings/{mine}"), Some(&cookie)).await;
    let csrf = field(&html, "csrf");
    let routes = |m: Uuid, n: Uuid| {
        vec![
            (
                format!("/meetings/{m}/title"),
                vec![("version", "0"), ("title", "x")],
            ),
            (format!("/meetings/{m}/archive"), vec![("version", "0")]),
            (format!("/meetings/{m}/restore"), vec![("version", "0")]),
            (
                format!("/meetings/{m}/notes"),
                vec![
                    ("submit_key", "6f1c1a7e-6c35-4c35-9a53-2b8e1f0a1b2c"),
                    ("body", "x"),
                ],
            ),
            (
                format!("/meetings/{m}/notes/{n}"),
                vec![("version", "1"), ("body", "x")],
            ),
            (
                format!("/meetings/{m}/notes/{n}/delete"),
                vec![("version", "1")],
            ),
        ]
    };
    let send =
        |path: &str, extra: &[(&str, &str)], token: &str, origin: Option<&str>, cookie: &str| {
            let mut f = vec![("csrf", token)];
            f.extend_from_slice(extra);
            let f: Vec<(String, String)> = f
                .iter()
                .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
                .collect();
            let path = path.to_owned();
            let origin = origin.map(str::to_owned);
            let cookie = cookie.to_owned();
            let h = &h;
            async move {
                let f: Vec<(&str, &str)> =
                    f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
                h.post(&path, &cookie, &f, origin.as_deref()).await.0
            }
        };
    for (path, extra) in routes(mine, their_note) {
        assert_eq!(
            send(&path, &extra, "wrong", None, &cookie).await,
            StatusCode::FORBIDDEN,
            "{path} csrf"
        );
        assert_eq!(
            send(&path, &extra, "", None, &cookie).await,
            StatusCode::FORBIDDEN,
            "{path} empty csrf"
        );
        assert_eq!(
            send(&path, &extra, &csrf, Some("https://evil.example"), &cookie).await,
            StatusCode::FORBIDDEN,
            "{path} cross-site"
        );
        assert_eq!(
            send(&path, &extra, &csrf, None, "cap_web=forged").await,
            StatusCode::SEE_OTHER,
            "{path} signed out"
        );
    }
    // Another tenant's meeting is invisible, and so is its note through my meeting.
    for (path, extra) in routes(theirs, their_note) {
        assert_eq!(
            send(&path, &extra, &csrf, None, &cookie).await,
            StatusCode::NOT_FOUND,
            "{path} other tenant"
        );
    }
    for (path, extra) in routes(mine, their_note).into_iter().skip(4) {
        let s = send(&path, &extra, &csrf, None, &cookie).await;
        assert!(
            s == StatusCode::CONFLICT || s == StatusCode::SEE_OTHER,
            "{path}: {s}"
        );
    }
    let body: String = sqlx::query_scalar("SELECT body FROM library_notes WHERE id = $1")
        .bind(their_note)
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(body, "other tenant secret plan", "never changed or deleted");
    let (_, _, search) = h.get("/meetings?q=secret", Some(&cookie)).await;
    assert!(!search.contains("Theirs") && !search.contains("secret plan"));

    // Staff (not admin): refused like viewing. Calari down: refused, fail closed.
    h.calari.lock().unwrap().status_role = "staff".into();
    for (path, extra) in routes(mine, their_note) {
        assert_eq!(
            send(&path, &extra, &csrf, None, &cookie).await,
            StatusCode::FORBIDDEN,
            "{path} staff"
        );
    }
    h.calari.lock().unwrap().status_role = "admin".into();
    h.calari.lock().unwrap().status_broken = true;
    for (path, extra) in routes(mine, their_note) {
        assert_eq!(
            send(&path, &extra, &csrf, None, &cookie).await,
            StatusCode::SERVICE_UNAVAILABLE,
            "{path} Calari down"
        );
    }
    h.calari.lock().unwrap().status_broken = false;
    // Offboarded: the session ends on the next edit, which is not saved.
    h.calari.lock().unwrap().active = false;
    h.calari.lock().unwrap().status_role = "none".into();
    let (path, extra) = &routes(mine, their_note)[3];
    assert_eq!(
        send(path, extra, &csrf, None, &cookie).await,
        StatusCode::SEE_OTHER
    );
    let written: i64 =
        sqlx::query_scalar("SELECT count(*) FROM library_notes WHERE meeting_id = $1")
            .bind(mine)
            .fetch_one(&h.state.db)
            .await
            .unwrap();
    let meta: i64 = sqlx::query_scalar("SELECT count(*) FROM library_meetings WHERE version > 0")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(
        (written, meta),
        (0, 0),
        "nothing was written by refused requests"
    );
    h.drop_db().await;
}

#[tokio::test]
async fn the_list_filters_real_data_and_shows_eastern_time() {
    let Some(h) = H::new().await else { return };
    let a = seed_meeting(&h, TENANT, "Budget review").await;
    let b = seed_meeting(&h, TENANT, "Team standup").await;
    sqlx::query("UPDATE meeting_sessions SET state = 'failed', started_at = '2026-07-01T13:05:00Z', ended_at = '2026-07-01T13:35:00Z' WHERE id = $1")
        .bind(b)
        .execute(&h.state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE meeting_transcripts SET segments = $2 WHERE meeting_id = $1")
        .bind(a)
        .bind(json!([
            {"start_ms": 0, "end_ms": 1000, "text": "Thank you."},
            {"start_ms": 1000, "end_ms": 2000, "text": "Thank you."},
            {"start_ms": 2000, "end_ms": 3000, "text": "Thank you."},
            {"start_ms": 3000, "end_ms": 4000, "text": "Let's look at the budget."}
        ]))
        .execute(&h.state.db)
        .await
        .unwrap();
    let cookie = h.sign_in().await;
    let (_, _, list) = h.get("/meetings", Some(&cookie)).await;
    assert!(list.contains("2 meetings"));
    assert!(list.contains("<details class=\"meeting\">"), "rows expand");
    assert!(list.contains("×3"), "repeated lines collapse");
    assert_eq!(list.matches("Thank you.").count(), 1);
    assert!(
        list.contains("Wednesday, Jul 1") && list.contains("9:05 AM EDT"),
        "Eastern time"
    );
    assert!(!list.contains("UTC"));
    assert!(list.contains("Desktop app") && list.contains("Acme &lt;Ltd&gt;"));
    let (_, _, failed) = h.get("/meetings?status=attention", Some(&cookie)).await;
    assert!(failed.contains("Team standup") && !failed.contains("Budget review"));
    assert!(failed.contains("1 of 2 meetings match"));
    let (_, _, internal) = h.get("/meetings?kind=internal", Some(&cookie)).await;
    assert!(internal.contains("No meetings match these filters"));
    let (_, _, ignored) = h
        .get("/meetings?status=bogus&kind=bogus", Some(&cookie))
        .await;
    assert!(
        ignored.contains("2 meetings"),
        "unknown filters are ignored"
    );
    let (_, _, detail) = h.get(&format!("/meetings/{a}"), Some(&cookie)).await;
    assert!(
        detail.contains("×3")
            && detail.contains("data-seek=\"0\"")
            && detail.contains("data-seek=\"3000\"")
    );
    assert!(!detail.contains("data-seek=\"1000\""));
    // Unsafe meeting links are shown as text, not links.
    sqlx::query("UPDATE meeting_sessions SET meeting_url = 'javascript:alert(1)' WHERE id = $1")
        .bind(a)
        .execute(&h.state.db)
        .await
        .unwrap();
    let (_, _, detail) = h.get(&format!("/meetings/{a}"), Some(&cookie)).await;
    assert!(!detail.contains("href=\"javascript:"));
    h.drop_db().await;
}

/// Local screenshot fixture, not a test: serves the real library on
/// 127.0.0.1 with synthetic data for two tenants. Run with
/// `CAP_FIXTURE_PORT=… CAP_FIXTURE_OUT=file CAP_FIXTURE_SECS=… cargo test --test library -- --ignored fixture`.
#[tokio::test]
#[ignore = "manual screenshot fixture"]
async fn fixture_server_for_screenshots() {
    let port: u16 = std::env::var("CAP_FIXTURE_PORT").map_or(18_731, |p| p.parse().unwrap());
    let base = format!("http://127.0.0.1:{port}");
    let Some(h) = H::new_at(&base).await else {
        return;
    };
    let db = h.state.db.clone();
    let audio = std::env::var("CAP_FIXTURE_AUDIO")
        .ok()
        .map(|p| std::fs::read(p).unwrap());
    let mut ids = Vec::new();
    let meetings: [(&str, &str, &str, i64, i64, &str); 7] = [
        (
            "Quarterly plan review",
            "delivered",
            "audio",
            0,
            46,
            "staff_client",
        ),
        (
            "Website refresh kickoff",
            "delivered",
            "video",
            3,
            32,
            "staff_client",
        ),
        (
            "Weekly ops standup",
            "transcribing",
            "audio",
            5,
            18,
            "internal_team",
        ),
        (
            "Insurance renewal call",
            "failed",
            "audio",
            26,
            12,
            "staff_client",
        ),
        (
            "New patient intake flow",
            "delivered",
            "audio",
            30,
            54,
            "staff_client",
        ),
        (
            "Listing photos follow-up",
            "recording",
            "video",
            0,
            0,
            "staff_client",
        ),
        (
            "Old onboarding call",
            "delivered",
            "audio",
            75,
            25,
            "staff_client",
        ),
    ];
    let clients = [
        "Northwind Dental",
        "Harbor & Pine Realty",
        "Bluebird Bakery",
    ];
    for (i, (title, st, mode, hours_ago, mins, kind)) in meetings.iter().enumerate() {
        let id = seed_meeting(&h, TENANT, title).await;
        let started =
            Utc::now() - chrono::Duration::hours(*hours_ago) - chrono::Duration::minutes(*mins + 5);
        let ended = (*st != "recording").then(|| started + chrono::Duration::minutes(*mins));
        sqlx::query("UPDATE meeting_sessions SET state = $2, capture_mode = $3, started_at = $4, ended_at = $5, source = $6, meeting_url = 'https://meet.google.com/abc-defg-hij' WHERE id = $1")
            .bind(id).bind(st).bind(mode).bind(started).bind(ended)
            .bind(["desktop", "extension", "calendar_bot"][i % 3])
            .execute(&db).await.unwrap();
        let pairing: Uuid =
            sqlx::query_scalar("SELECT pairing_id FROM meeting_sessions WHERE id = $1")
                .bind(id)
                .fetch_one(&db)
                .await
                .unwrap();
        if *kind == "internal_team" {
            sqlx::query("UPDATE meeting_pairings SET pairing_kind = 'internal_team', client_id = NULL, client_display_name = NULL WHERE id = $1")
                .bind(pairing).execute(&db).await.unwrap();
        } else {
            sqlx::query("UPDATE meeting_pairings SET client_display_name = $2 WHERE id = $1")
                .bind(pairing)
                .bind(clients[i % 3])
                .execute(&db)
                .await
                .unwrap();
        }
        if let Some(a) = &audio {
            let key: String =
                sqlx::query_scalar("SELECT object_key FROM meeting_chunks WHERE meeting_id = $1")
                    .bind(id)
                    .fetch_one(&db)
                    .await
                    .unwrap();
            h.state
                .store
                .put(&key, a.clone(), "audio/ogg")
                .await
                .unwrap();
            sqlx::query("UPDATE meeting_chunks SET size_bytes = $2, duration_ms = 20000 WHERE meeting_id = $1").bind(id).bind(a.len() as i64).execute(&db).await.unwrap();
        }
        if *st == "recording" || *st == "transcribing" {
            sqlx::query("DELETE FROM meeting_transcripts WHERE meeting_id = $1")
                .bind(id)
                .execute(&db)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE meeting_transcripts SET segments = $2 WHERE meeting_id = $1")
                .bind(id)
                .bind(json!([
                    {"start_ms": 0, "end_ms": 2000, "text": "Thank you."},
                    {"start_ms": 2000, "end_ms": 4000, "text": "Thank you."},
                    {"start_ms": 4000, "end_ms": 6000, "text": "Thank you."},
                    {"start_ms": 6500, "end_ms": 11000, "text": "Let's start with the numbers from last quarter and what changed."},
                    {"start_ms": 11000, "end_ms": 16000, "text": "Bookings were up, but follow-ups slipped after the second week."},
                    {"start_ms": 16000, "end_ms": 21000, "text": "Can we send the photos and the revised schedule by Friday?"},
                    {"start_ms": 21000, "end_ms": 25000, "text": "Yes, I'll own that and share it in the portal."}
                ]))
                .execute(&db).await.unwrap();
        }
        if *st == "delivered" {
            seed_delivery(&h, id).await;
        }
        if *st == "failed" {
            sqlx::query("UPDATE meeting_sessions SET failure = 'Transcription failed after 5 attempts; the audio is kept.' WHERE id = $1").bind(id).execute(&db).await.unwrap();
            sqlx::query("DELETE FROM meeting_transcripts WHERE meeting_id = $1")
                .bind(id)
                .execute(&db)
                .await
                .unwrap();
        }
        ids.push(id);
    }
    let note = |m: Uuid, body: &'static str, who: &'static str| {
        let db = db.clone();
        async move {
            sqlx::query("INSERT INTO library_meetings (meeting_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(m).bind(TENANT).execute(&db).await.unwrap();
            sqlx::query(
                "INSERT INTO library_notes (id, meeting_id, tenant_id, body, submit_key, created_by, created_by_name, updated_by, updated_by_name, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'u1', $6, 'u1', $6, now() - interval '20 minutes', now() - interval '20 minutes')",
            )
            .bind(Uuid::new_v4()).bind(m).bind(TENANT).bind(body).bind(Uuid::new_v4()).bind(who)
            .execute(&db).await.unwrap();
        }
    };
    note(ids[0], "Decisions:\n- Keep the spring promotion running through April.\n- Move follow-up calls to Tuesdays.\n\nOwner for the revised schedule: Jordan.", "Jordan Lee").await;
    note(
        ids[0],
        "Ask about the second location before the next review.",
        "Sam Rivera",
    )
    .await;
    note(
        ids[1],
        "Homepage hero should lead with booking, not the gallery.",
        "Sam Rivera",
    )
    .await;
    sqlx::query("UPDATE library_meetings SET display_title = 'Northwind Q2 planning', version = 1 WHERE meeting_id = $1").bind(ids[0]).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO library_meetings (meeting_id, tenant_id, archived_at, archived_by, version) VALUES ($1, $2, now(), 'u1', 1)").bind(ids[6]).bind(TENANT).execute(&db).await.unwrap();
    // The other tenant: must never appear.
    let other = seed_meeting(&h, OTHER_TENANT, "OTHER TENANT – must not appear").await;
    let cookie = h.sign_in().await;
    let out = std::env::var("CAP_FIXTURE_OUT").unwrap_or_else(|_| "fixture.json".into());
    std::fs::write(
        &out,
        json!({"base": base, "cookie": cookie, "meetings": ids, "other": other}).to_string(),
    )
    .unwrap();
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    let app = router(h.state.clone());
    let secs: u64 = std::env::var("CAP_FIXTURE_SECS").map_or(120, |s| s.parse().unwrap());
    let _ = tokio::time::timeout(Duration::from_secs(secs), axum::serve(l, app)).await;
    h.drop_db().await;
}
