//! Real-HTTP stand-ins for Google (OAuth, Calendar, revoke) and Calari
//! (staff sign-in, calendar resolve/pairing, signed delivery receiver), with
//! the real Cap server listening on a local port. Needs
//! `CAP_TEST_DATABASE_URL`; each world creates and drops its own database.
//! No real Google, Calari, meeting or client is ever contacted.

#![allow(clippy::unwrap_used, dead_code)]

use axum::{
    extract::{Form, Query},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Router,
};
use cap_meeting_protocol::{
    ids, pkce_s256, signing, CalendarPairingRequest, CalendarResolveRequest, LoginExchangeRequest,
    LoginStatusRequest,
};
use cap_server::{
    config::{
        CalendarConfig, Config, GoogleEndpoints, Integration, Secret, Secret32, StorageConfig,
        TranscriptionConfig,
    },
    AppState,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

pub const SECRET: [u8; 32] = [23; 32];
pub const TENANT: &str = "00000000-0000-4000-8000-0000000000aa";
pub const BOT_TOKEN: &str = "test-runner-token-0123456789abcdef";
pub const GOOGLE_CLIENT_SECRET: &str = "google-client-secret-value";

// ---------------- Google ----------------

#[derive(Default)]
pub struct Cal {
    /// (generation, event) in change order; the latest per id wins.
    pub log: Vec<(u64, Value)>,
    pub generation: u64,
}

#[derive(Default)]
pub struct Google {
    /// code -> (challenge, redirect_uri, email)
    pub codes: HashMap<String, (String, String, String)>,
    pub refresh: HashMap<String, String>,
    pub access: HashMap<String, String>,
    pub revoked: HashSet<String>,
    pub revoke_calls: Vec<String>,
    pub cals: HashMap<String, Cal>,
    /// Every events request's query (minus the bearer).
    pub event_requests: Vec<BTreeMap<String, String>>,
    /// Fail this many requests that carry a pageToken, with this status.
    pub fail_paged: Option<(usize, u16)>,
    pub grant_scope: String,
    pub omit_refresh: bool,
    pub email_verified: bool,
    pub page_size: usize,
    pub counter: u64,
}

impl Google {
    pub fn add(&mut self, email: &str, event: Value) {
        let cal = self.cals.entry(email.to_owned()).or_default();
        cal.generation += 1;
        let g = cal.generation;
        cal.log.push((g, event));
    }

    fn current(cal: &Cal) -> Vec<Value> {
        let mut latest: BTreeMap<String, (u64, Value)> = BTreeMap::new();
        for (g, e) in &cal.log {
            latest.insert(e["id"].as_str().unwrap().to_owned(), (*g, e.clone()));
        }
        let mut v: Vec<(u64, Value)> = latest.into_values().collect();
        v.sort_by_key(|(g, _)| *g);
        v.into_iter().map(|(_, e)| e).collect()
    }
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned()
}

async fn spawn(app: Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    url
}

async fn spawn_google(g: Arc<Mutex<Google>>) -> String {
    let (g1, g2, g3, g4) = (g.clone(), g.clone(), g.clone(), g.clone());
    let app = Router::new()
        .route(
            "/token",
            post(move |Form(f): Form<HashMap<String, String>>| {
                let g = g1.clone();
                async move {
                    let mut g = g.lock().unwrap();
                    if f.get("client_id").map(String::as_str) != Some("google-client-id")
                        || f.get("client_secret").map(String::as_str) != Some(GOOGLE_CLIENT_SECRET)
                    {
                        return (StatusCode::UNAUTHORIZED, json!({"error":"invalid_client"}).to_string());
                    }
                    g.counter += 1;
                    let n = g.counter;
                    match f.get("grant_type").map(String::as_str) {
                        Some("authorization_code") => {
                            let code = f.get("code").cloned().unwrap_or_default();
                            match g.codes.remove(&code) {
                                Some((challenge, redirect, email))
                                    if pkce_s256(f.get("code_verifier").map(String::as_str).unwrap_or("")) == challenge
                                        && f.get("redirect_uri") == Some(&redirect) =>
                                {
                                    let rt = format!("1//refresh-{n}-{}", ids::random_token(12));
                                    let at = format!("ya29.access-{n}");
                                    g.refresh.insert(rt.clone(), email.clone());
                                    g.access.insert(at.clone(), email);
                                    let mut body = json!({"access_token": at, "expires_in": 3599, "token_type": "Bearer", "scope": g.grant_scope});
                                    if !g.omit_refresh {
                                        body["refresh_token"] = json!(rt);
                                    }
                                    (StatusCode::OK, body.to_string())
                                }
                                _ => (StatusCode::BAD_REQUEST, json!({"error":"invalid_grant"}).to_string()),
                            }
                        }
                        Some("refresh_token") => {
                            let rt = f.get("refresh_token").cloned().unwrap_or_default();
                            match g.refresh.get(&rt).cloned() {
                                Some(email) if !g.revoked.contains(&rt) => {
                                    let at = format!("ya29.access-{n}");
                                    g.access.insert(at.clone(), email);
                                    (StatusCode::OK, json!({"access_token": at, "expires_in": 3599}).to_string())
                                }
                                _ => (StatusCode::BAD_REQUEST, json!({"error":"invalid_grant"}).to_string()),
                            }
                        }
                        _ => (StatusCode::BAD_REQUEST, json!({"error":"unsupported_grant_type"}).to_string()),
                    }
                }
            }),
        )
        .route(
            "/revoke",
            post(move |Form(f): Form<HashMap<String, String>>| {
                let g = g2.clone();
                async move {
                    let mut g = g.lock().unwrap();
                    let t = f.get("token").cloned().unwrap_or_default();
                    g.revoke_calls.push(t.clone());
                    g.revoked.insert(t);
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/oauth2/v3/userinfo",
            get(move |headers: HeaderMap| {
                let g = g3.clone();
                async move {
                    let g = g.lock().unwrap();
                    match g.access.get(&bearer(&headers)) {
                        Some(email) => (StatusCode::OK, json!({"sub": "1", "email": email, "email_verified": g.email_verified}).to_string()),
                        None => (StatusCode::UNAUTHORIZED, "{}".into()),
                    }
                }
            }),
        )
        .route(
            "/calendar/v3/calendars/primary/events",
            get(move |headers: HeaderMap, Query(q): Query<BTreeMap<String, String>>| {
                let g = g4.clone();
                async move {
                    let mut g = g.lock().unwrap();
                    let Some(email) = g.access.get(&bearer(&headers)).cloned() else {
                        return (StatusCode::UNAUTHORIZED, "{}".into());
                    };
                    g.event_requests.push(q.clone());
                    if q.contains_key("pageToken") {
                        if let Some((n, code)) = g.fail_paged {
                            if n > 0 {
                                g.fail_paged = if n > 1 { Some((n - 1, code)) } else { None };
                                return (StatusCode::from_u16(code).unwrap(), "{}".into());
                            }
                        }
                    }
                    assert_eq!(q.get("singleEvents").map(String::as_str), Some("true"));
                    assert_eq!(q.get("showDeleted").map(String::as_str), Some("true"));
                    let page_size = g.page_size.max(1);
                    assert!(!q.contains_key("syncToken"), "bounded windows only");
                    let min = DateTime::parse_from_rfc3339(q.get("timeMin").expect("timeMin")).unwrap();
                    let max = DateTime::parse_from_rfc3339(q.get("timeMax").expect("timeMax: an endless series must stay finite")).unwrap();
                    assert!(max > min);
                    let cal = g.cals.entry(email).or_default();
                    // Overlapping the window, as Google filters (end > min, start < max).
                    let items: Vec<Value> = Google::current(cal)
                        .into_iter()
                        .filter(|e| {
                            let t = |k: &str| e[k]["dateTime"].as_str().and_then(|v| DateTime::parse_from_rfc3339(v).ok());
                            match (t("start"), t("end")) {
                                (Some(st), Some(en)) => en > min && st < max,
                                _ => true,
                            }
                        })
                        .collect();
                    let offset: usize = q.get("pageToken").map(|p| p.trim_start_matches('p').parse().unwrap()).unwrap_or(0);
                    let page: Vec<Value> = items.iter().skip(offset).take(page_size).cloned().collect();
                    let mut body = json!({"items": page});
                    if offset + page_size < items.len() {
                        body["nextPageToken"] = json!(format!("p{}", offset + page_size));
                    } else {
                        body["nextSyncToken"] = json!("unused-by-cap");
                    }
                    (StatusCode::OK, body.to_string())
                }
            }),
        );
    spawn(app).await
}

// ---------------- Calari ----------------

#[derive(Default)]
pub struct Calari {
    /// login code -> (challenge, redirect_uri, user_id)
    pub codes: HashMap<String, (String, String, String)>,
    /// user_id -> (email, active)
    pub users: HashMap<String, (String, bool)>,
    /// verified client contact email -> (client_id, name)
    pub clients: HashMap<String, (String, String)>,
    pub refuse_pairing: bool,
    pub pairing_requests: Vec<CalendarPairingRequest>,
    pub resolve_calls: usize,
    pub deliveries: Vec<Value>,
    pub cap_url: Option<String>,
    pub bad_signatures: usize,
}

fn verify(purpose: signing::Purpose, headers: &HeaderMap, body: &[u8]) -> bool {
    let h = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    };
    signing::verify(
        &SECRET,
        purpose,
        &h(signing::HEADER_TIMESTAMP),
        &h(signing::HEADER_NONCE),
        &h(signing::HEADER_SIGNATURE),
        body,
        Utc::now().timestamp(),
    )
    .is_ok()
}

async fn spawn_calari(c: Arc<Mutex<Calari>>) -> String {
    let (c1, c2, c3, c4, c5) = (c.clone(), c.clone(), c.clone(), c.clone(), c.clone());
    let app = Router::new()
        .route("/exchange", post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let c = c1.clone();
            async move {
                if !verify(signing::Purpose::Login, &headers, &body) {
                    return (StatusCode::UNAUTHORIZED, String::new());
                }
                let req: LoginExchangeRequest = serde_json::from_slice(&body).unwrap();
                let mut c = c.lock().unwrap();
                match c.codes.remove(&req.code) {
                    Some((ch, redirect, user)) if ch == pkce_s256(&req.code_verifier) && redirect == req.redirect_uri => {
                        let email = c.users[&user].0.clone();
                        (StatusCode::OK, json!({"tenant_id": TENANT, "user_id": user, "email": email, "display_name": user, "role": "staff"}).to_string())
                    }
                    _ => (StatusCode::BAD_REQUEST, "{}".into()),
                }
            }
        }))
        .route("/status", post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let c = c2.clone();
            async move {
                if !verify(signing::Purpose::Login, &headers, &body) {
                    return (StatusCode::UNAUTHORIZED, String::new());
                }
                let req: LoginStatusRequest = serde_json::from_slice(&body).unwrap();
                let c = c.lock().unwrap();
                let (email, active) = c.users.get(&req.user_id).cloned().unwrap_or_default();
                (StatusCode::OK, json!({"tenant_id": TENANT, "user_id": req.user_id, "email": email, "display_name": req.user_id, "role": "staff", "active": active}).to_string())
            }
        }))
        .route("/calendar/resolve", post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let c = c3.clone();
            async move {
                let mut c = c.lock().unwrap();
                if !verify(signing::Purpose::Calendar, &headers, &body) {
                    c.bad_signatures += 1;
                    return (StatusCode::UNAUTHORIZED, String::new());
                }
                c.resolve_calls += 1;
                let req: CalendarResolveRequest = serde_json::from_slice(&body).unwrap();
                assert!(req.attendee_emails.len() <= cap_meeting_protocol::MAX_CALENDAR_ATTENDEES);
                let active = c.users.get(&req.user_id).is_some_and(|u| u.1);
                let mappings: Vec<Value> = if active {
                    req.attendee_emails.iter().filter_map(|e| c.clients.get(e).map(|(id, name)| json!({"email": e, "client_id": id, "client_display_name": name}))).collect()
                } else {
                    vec![]
                };
                (StatusCode::OK, json!({"tenant_id": TENANT, "user_id": req.user_id, "active": active, "mappings": mappings}).to_string())
            }
        }))
        .route("/calendar/pairing", post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let c = c4.clone();
            async move {
                let (cap, refuse) = {
                    let mut g = c.lock().unwrap();
                    if !verify(signing::Purpose::Calendar, &headers, &body) {
                        g.bad_signatures += 1;
                        return (StatusCode::UNAUTHORIZED, String::new());
                    }
                    let req: CalendarPairingRequest = serde_json::from_slice(&body).unwrap();
                    let active = g.users.get(&req.user_id).is_some_and(|u| u.1);
                    // Kind and client must agree; no client never implies internal.
                    let consistent = match req.pairing_kind {
                        cap_meeting_protocol::PairingKind::StaffClient => req.client_id.is_some(),
                        cap_meeting_protocol::PairingKind::InternalTeam => req.client_id.is_none(),
                        _ => false,
                    };
                    let refuse = g.refuse_pairing || !active || !consistent
                        || req.client_id.as_ref().is_some_and(|id| !g.clients.values().any(|(c, _)| c == id));
                    g.pairing_requests.push(req);
                    (g.cap_url.clone().unwrap(), refuse)
                };
                if refuse {
                    return (StatusCode::FORBIDDEN, json!({"error": "forbidden"}).to_string());
                }
                let req: CalendarPairingRequest = serde_json::from_slice(&body).unwrap();
                // Calari creates its own pairing record, then asks Cap exactly
                // as for any other pairing.
                let pairing = json!({
                    "request_id": req.request_id, "tenant_id": TENANT,
                    "pairing_kind": req.pairing_kind.as_str(),
                    "client_id": req.client_id, "ttl_seconds": 600
                });
                let pbody = serde_json::to_vec(&pairing).unwrap();
                let ts = Utc::now().timestamp();
                let nonce = signing::new_nonce();
                let sig = signing::sign(&SECRET, signing::Purpose::Pairing, ts, &nonce, &pbody).unwrap();
                let res = reqwest::Client::new()
                    .post(format!("{cap}/v1/pairings"))
                    .header("content-type", "application/json")
                    .header(signing::HEADER_KEY_ID, "calari-test")
                    .header(signing::HEADER_TIMESTAMP, ts.to_string())
                    .header(signing::HEADER_NONCE, nonce)
                    .header(signing::HEADER_SIGNATURE, sig)
                    .body(pbody)
                    .send()
                    .await
                    .unwrap();
                let v: Value = res.json().await.unwrap();
                (StatusCode::OK, json!({"pairing_id": v["pairing_id"], "code": v["code"], "expires_at": v["expires_at"]}).to_string())
            }
        }))
        .route("/deliver", post(move |headers: HeaderMap, body: axum::body::Bytes| {
            let c = c5.clone();
            async move {
                let ok = verify(signing::Purpose::Delivery, &headers, &body)
                    && headers.get(signing::HEADER_CONTENT_SHA256).and_then(|v| v.to_str().ok()) == Some(ids::sha256_hex(&body).as_str());
                let mut c = c.lock().unwrap();
                if !ok {
                    c.bad_signatures += 1;
                    return (StatusCode::UNAUTHORIZED, String::new());
                }
                c.deliveries.push(serde_json::from_slice(&body).unwrap());
                (StatusCode::OK, json!({"receipt_id": format!("rcpt-{}", c.deliveries.len()), "status": "accepted"}).to_string())
            }
        }));
    spawn(app).await
}

// ---------------- World ----------------

pub struct Session {
    pub cookie: String,
    pub csrf: String,
    pub user_id: String,
}

pub struct World {
    pub cap: String,
    pub state: AppState,
    pub google: Arc<Mutex<Google>>,
    pub calari: Arc<Mutex<Calari>>,
    pub http: reqwest::Client,
    admin_url: String,
    db: String,
    _dir: TempDir,
}

pub struct TempDir(pub std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn event(
    id: &str,
    start: DateTime<Utc>,
    minutes: i64,
    code: &str,
    attendees: &[&str],
) -> Value {
    let mut a: Vec<Value> =
        vec![json!({"email": "owner@calari.test", "self": true, "responseStatus": "accepted"})];
    a.extend(
        attendees
            .iter()
            .map(|e| json!({"email": e, "responseStatus": "needsAction"})),
    );
    json!({
        "id": id, "status": "confirmed", "summary": format!("Meeting {id}"),
        "updated": Utc::now().to_rfc3339(),
        "start": {"dateTime": start.to_rfc3339()},
        "end": {"dateTime": (start + chrono::Duration::minutes(minutes)).to_rfc3339()},
        "hangoutLink": format!("https://meet.google.com/{code}"),
        "attendees": a,
    })
}

impl World {
    pub async fn new(transcription: TranscriptionConfig) -> Option<Self> {
        Self::with_staff_access(transcription, true).await
    }

    pub async fn with_staff_access(
        transcription: TranscriptionConfig,
        allow_staff: bool,
    ) -> Option<Self> {
        Self::with_settings(transcription, allow_staff, 90).await
    }

    pub async fn with_settings(
        transcription: TranscriptionConfig,
        allow_staff: bool,
        bot_lease_seconds: i64,
    ) -> Option<Self> {
        let Ok(admin_url) = std::env::var("CAP_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set CAP_TEST_DATABASE_URL to run calendar tests");
            return None;
        };
        let db = format!("c_{}", Uuid::new_v4().simple());
        let admin = sqlx::PgPool::connect(&admin_url).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {db}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        let url = format!("{}/{db}", admin_url.rsplit_once('/').unwrap().0);
        let google = Arc::new(Mutex::new(Google {
            grant_scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.readonly".into(),
            email_verified: true,
            page_size: 2,
            ..Default::default()
        }));
        let calari = Arc::new(Mutex::new(Calari::default()));
        let g = spawn_google(google.clone()).await;
        let c = spawn_calari(calari.clone()).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cap = format!("http://{}", listener.local_addr().unwrap());
        calari.lock().unwrap().cap_url = Some(cap.clone());
        let dir = std::env::temp_dir().join(format!("cap-cal-{}", Uuid::new_v4().simple()));
        let mut key = [0u8; 32];
        key.iter_mut()
            .enumerate()
            .for_each(|(i, b)| *b = (i as u8).wrapping_mul(37).wrapping_add(5));
        let cfg = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_url: Secret(url),
            storage: StorageConfig::Filesystem { root: dir.clone() },
            public_base_url: cap.clone(),
            production: false,
            trusted_proxy_hops: 0,
            integrations: vec![Integration {
                key_id: "calari-test".into(),
                tenant_id: TENANT.into(),
                secret: SECRET.to_vec(),
                delivery_url: format!("{c}/deliver"),
                login_authorize_url: Some("https://calari.test/authorize".into()),
                login_exchange_url: Some(format!("{c}/exchange")),
                login_status_url: Some(format!("{c}/status")),
                calendar_resolve_url: Some(format!("{c}/calendar/resolve")),
                calendar_pairing_url: Some(format!("{c}/calendar/pairing")),
            }],
            transcription,
            abandon_after: Duration::from_secs(3600),
            worker_interval: Duration::from_millis(100),
            download_dir: None,
            portal_url: None,
            ffmpeg_path: std::env::var("CAP_TEST_FFMPEG").unwrap_or_else(|_| "ffmpeg".into()),
            calendar: Some(CalendarConfig {
                google_client_id: "google-client-id".into(),
                google_client_secret: Secret(GOOGLE_CLIENT_SECRET.into()),
                google: GoogleEndpoints {
                    auth_url: "https://accounts.google.test/o/oauth2/v2/auth".into(),
                    token_url: format!("{g}/token"),
                    revoke_url: format!("{g}/revoke"),
                    api_base: g.clone(),
                },
                encryption_key: Secret32(key),
                encryption_key_id: "test-v1".into(),
                bot_token_sha256: ids::sha256_hex(BOT_TOKEN.as_bytes()),
                max_concurrent: 1,
                join_lead: Duration::from_secs(120),
                sync_interval: Duration::from_secs(300),
                horizon: Duration::from_secs(14 * 86_400),
                bot_display_name: "Calari Notetaker".into(),
                require_same_email: true,
                bot_lease_seconds,
                display_tz: "America/New_York".parse().unwrap(),
                allow_staff,
            }),
        };
        cfg.validate().unwrap();
        let state = AppState::new(cfg).await.unwrap();
        let app = cap_server::router(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        Some(Self {
            cap,
            state,
            google,
            calari,
            http,
            admin_url,
            db,
            _dir: TempDir(dir),
        })
    }

    pub fn staff(&self, user_id: &str, email: &str) {
        self.calari
            .lock()
            .unwrap()
            .users
            .insert(user_id.into(), (email.into(), true));
    }

    pub fn client(&self, email: &str, client_id: Uuid, name: &str) {
        self.calari
            .lock()
            .unwrap()
            .clients
            .insert(email.into(), (client_id.to_string(), name.into()));
    }

    fn set_cookie(res: &reqwest::Response, name: &str) -> Option<String> {
        res.headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find(|c| c.starts_with(&format!("{name}=")))
            .map(|c| c.split(';').next().unwrap().to_owned())
    }

    pub async fn sign_in(&self, user_id: &str) -> Session {
        let res = self
            .http
            .get(format!("{}/login", self.cap))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 303);
        let login = Self::set_cookie(&res, "cap_login").unwrap();
        let loc = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
        let q: HashMap<_, _> = loc.query_pairs().into_owned().collect();
        let code = ids::random_token(24);
        self.calari.lock().unwrap().codes.insert(
            code.clone(),
            (
                q["code_challenge"].clone(),
                q["redirect_uri"].clone(),
                user_id.into(),
            ),
        );
        let res = self
            .http
            .get(format!(
                "{}/auth/calari/callback?code={code}&state={}",
                self.cap, q["state"]
            ))
            .header("cookie", &login)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 303);
        let cookie = Self::set_cookie(&res, "cap_web").unwrap();
        let token = cookie.split_once('=').unwrap().1;
        let csrf = ids::sha256_hex(
            format!("cap.csrf.v1:{}", ids::sha256_hex(token.as_bytes())).as_bytes(),
        );
        Session {
            cookie,
            csrf,
            user_id: user_id.into(),
        }
    }

    pub async fn post_form(
        &self,
        s: &Session,
        path: &str,
        fields: &[(&str, &str)],
    ) -> reqwest::Response {
        let mut form: Vec<(&str, &str)> = vec![("csrf", &s.csrf)];
        form.extend_from_slice(fields);
        self.http
            .post(format!("{}{path}", self.cap))
            .header("cookie", &s.cookie)
            .header("origin", &self.cap)
            .form(&form)
            .send()
            .await
            .unwrap()
    }

    /// Starts the Google connection; returns (browser cookie, Google query).
    pub async fn begin_connect(&self, s: &Session) -> (String, HashMap<String, String>) {
        let res = self.post_form(s, "/calendar/connect", &[]).await;
        assert_eq!(res.status(), 303, "{:?}", res.text().await);
        let browser = Self::set_cookie(&res, "cap_cal").unwrap();
        let loc = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
        assert!(loc
            .as_str()
            .starts_with("https://accounts.google.test/o/oauth2/v2/auth?"));
        (browser, loc.query_pairs().into_owned().collect())
    }

    /// Plays Google's consent screen for `email`.
    pub fn consent(&self, q: &HashMap<String, String>, email: &str) -> String {
        let code = format!("4/{}", ids::random_token(24));
        self.google.lock().unwrap().codes.insert(
            code.clone(),
            (
                q["code_challenge"].clone(),
                q["redirect_uri"].clone(),
                email.into(),
            ),
        );
        code
    }

    pub async fn callback(
        &self,
        s: &Session,
        browser: Option<&str>,
        code: &str,
        state: &str,
    ) -> reqwest::Response {
        let cookie = match browser {
            Some(b) => format!("{}; {b}", s.cookie),
            None => s.cookie.clone(),
        };
        self.http
            .get(format!(
                "{}/calendar/google/callback?code={}&state={state}",
                self.cap,
                urlencode(code)
            ))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
    }

    pub async fn connect(&self, s: &Session, email: &str) {
        let (browser, q) = self.begin_connect(s).await;
        let code = self.consent(&q, email);
        let res = self.callback(s, Some(&browser), &code, &q["state"]).await;
        assert_eq!(res.status(), 303, "{:?}", res.text().await);
        assert_eq!(res.headers()["location"], "/calendar");
    }

    pub async fn sync(&self, now: DateTime<Utc>) {
        // Force due and run until idle.
        sqlx::query("UPDATE calendar_connections SET next_sync_at = $1 WHERE status = 'active'")
            .bind(now)
            .execute(&self.state.db)
            .await
            .unwrap();
        for _ in 0..20 {
            if !cap_server::attendance::sync::sync_due(&self.state, now)
                .await
                .unwrap()
            {
                break;
            }
        }
    }

    pub async fn bot(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut b = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.cap))
            .header("authorization", format!("Bearer {BOT_TOKEN}"));
        if let Some(v) = body {
            b = b.json(&v);
        }
        let res = b.send().await.unwrap();
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn attendances(
        &self,
    ) -> Vec<(Uuid, String, String, Option<Uuid>, i32, DateTime<Utc>)> {
        sqlx::query_as("SELECT id, state, routing, client_id, version, starts_at FROM calendar_attendances ORDER BY created_at")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }

    pub async fn drop_db(self) {
        self.state.db.close().await;
        let admin = sqlx::PgPool::connect(&self.admin_url).await.unwrap();
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.db))
            .execute(&admin)
            .await
            .unwrap();
    }
}

pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
