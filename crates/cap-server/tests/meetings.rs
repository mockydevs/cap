//! End-to-end tests for the meeting pipeline against a real PostgreSQL.
//!
//! Needs `CAP_TEST_DATABASE_URL` (for example the `postgres-test` service in
//! `docker-compose.test.yml`: `postgres://cap:cap@127.0.0.1:5433/cap_test`).
//! Each test creates and drops its own database.

#![allow(clippy::unwrap_used)]

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::post,
    Router,
};
use cap_meeting_protocol::{ids, signing, DeliveryPayload};
use cap_server::{
    config::{Config, Integration, Secret, StorageConfig, TranscriptionConfig},
    meetings::worker,
    router, AppState,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: [u8; 32] = [42; 32];
const TENANT: &str = "00000000-0000-4000-8000-000000000001";
const CLIENT: &str = "00000000-0000-4000-8000-000000000002";
const RECEIPT: &str = "00000000-0000-4000-8000-000000000003";

#[derive(Default)]
struct Mock {
    /// Status codes to answer with, in order; 200 once empty.
    script: VecDeque<u16>,
    received: Vec<(axum::http::HeaderMap, Vec<u8>)>,
    calls: Vec<String>,
}

type Shared = Arc<Mutex<Mock>>;

async fn spawn(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// A Calari receiver that verifies the request exactly as the contract says.
async fn mock_calari(shared: Shared) -> String {
    let app = Router::new().route(
        "/deliver",
        post(
            move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let shared = shared.clone();
                async move {
                    let h = |n: &str| headers.get(n).unwrap().to_str().unwrap().to_owned();
                    let ok = signing::verify(
                        &SECRET,
                        signing::Purpose::Delivery,
                        &h(signing::HEADER_TIMESTAMP),
                        &h(signing::HEADER_NONCE),
                        &h(signing::HEADER_SIGNATURE),
                        &body,
                        Utc::now().timestamp(),
                    )
                    .is_ok()
                        && h(signing::HEADER_CONTENT_SHA256) == ids::sha256_hex(&body);
                    let mut m = shared.lock().unwrap();
                    m.received.push((headers.clone(), body.to_vec()));
                    if !ok {
                        return (StatusCode::UNAUTHORIZED, "bad signature".to_owned());
                    }
                    let code = m.script.pop_front().unwrap_or(200);
                    (
                        StatusCode::from_u16(code).unwrap(),
                        json!({"receipt_id": "rcpt-1", "status": "accepted"}).to_string(),
                    )
                }
            },
        ),
    );
    format!("{}/deliver", spawn(app).await)
}

/// An OpenAI-compatible transcription server; fails per the script.
async fn mock_whisper(shared: Shared) -> String {
    let app = Router::new().route(
        "/v1/audio/transcriptions",
        post(move |mut multipart: axum::extract::Multipart| {
            let shared = shared.clone();
            async move {
                let mut name = String::new();
                while let Some(field) = multipart.next_field().await.unwrap() {
                    if field.name() == Some("file") {
                        name = field.file_name().unwrap_or_default().to_owned();
                    }
                    let _ = field.bytes().await;
                }
                let mut m = shared.lock().unwrap();
                m.calls.push(name.clone());
                let code = m.script.pop_front().unwrap_or(200);
                let body = json!({
                    "language": "english",
                    "segments": [{"start": 0.5, "end": 2.0, "text": format!(" words from {name} ")}]
                });
                (StatusCode::from_u16(code).unwrap(), body.to_string())
            }
        }),
    );
    format!("{}/v1", spawn(app).await)
}

struct Harness {
    state: AppState,
    admin_url: String,
    db_name: String,
    calari: Shared,
}

impl Harness {
    async fn new(transcription: TranscriptionConfig, calari: Shared) -> Option<Self> {
        let Ok(admin_url) = std::env::var("CAP_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set CAP_TEST_DATABASE_URL to run database tests");
            return None;
        };
        let db_name = format!("t_{}", Uuid::new_v4().simple());
        let admin = sqlx::PgPool::connect(&admin_url).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE {db_name}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        let url = match admin_url.rsplit_once('/') {
            Some((base, _)) => format!("{base}/{db_name}"),
            None => unreachable!(),
        };
        let delivery_url = mock_calari(calari.clone()).await;
        let cfg = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            database_url: Secret(url),
            storage: StorageConfig::Filesystem {
                root: std::env::temp_dir().join(format!("cap-test-{db_name}")),
            },
            public_base_url: "http://cap.test".into(),
            production: false,
            trusted_proxy_hops: 0,
            integrations: vec![Integration {
                key_id: "calari-test".into(),
                tenant_id: TENANT.into(),
                secret: SECRET.to_vec(),
                delivery_url,
            }],
            transcription,
            abandon_after: Duration::from_secs(3600),
            worker_interval: Duration::from_millis(50),
            site_dir: None,
            ffmpeg_path: "ffmpeg".into(),
        };
        cfg.validate().unwrap();
        let state = AppState::new(cfg).await.unwrap();
        Some(Self {
            state,
            admin_url,
            db_name,
            calari,
        })
    }

    async fn call(&self, req: Request<Body>) -> (StatusCode, Value) {
        let res = router(self.state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn signed(
        &self,
        body: &Value,
        nonce: &str,
        ts: i64,
        purpose: signing::Purpose,
    ) -> Request<Body> {
        let raw = serde_json::to_vec(body).unwrap();
        Request::post("/v1/pairings")
            .header("content-type", "application/json")
            .header(signing::HEADER_KEY_ID, "calari-test")
            .header(signing::HEADER_TIMESTAMP, ts.to_string())
            .header(signing::HEADER_NONCE, nonce)
            .header(
                signing::HEADER_SIGNATURE,
                signing::sign(&SECRET, purpose, ts, nonce, &raw).unwrap(),
            )
            .body(Body::from(raw))
            .unwrap()
    }

    async fn pair(&self, body: &Value) -> (StatusCode, Value) {
        self.call(self.signed(
            body,
            &signing::new_nonce(),
            Utc::now().timestamp(),
            signing::Purpose::Pairing,
        ))
        .await
    }

    async fn redeem(&self, code: &str) -> (StatusCode, Value) {
        self.call(json_req(
            "POST",
            "/v1/pairings/redeem",
            None,
            &json!({
                "code": code, "device_name": "Clare's laptop", "device_kind": "extension"
            }),
        ))
        .await
    }

    /// Pairing + redemption; returns the device token.
    async fn device(&self, body: Value) -> String {
        let (s, p) = self.pair(&body).await;
        assert_eq!(s, StatusCode::CREATED, "{p}");
        let (s, r) = self.redeem(p["code"].as_str().unwrap()).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        r["device_token"].as_str().unwrap().to_owned()
    }

    async fn meeting(&self, token: &str, key: &str) -> String {
        let (s, m) = self.call(json_req("POST", "/v1/meetings", Some(token), &json!({
            "title": "Acme kickoff", "idempotency_key": key, "started_at": Utc::now() - chrono::Duration::minutes(30),
            "meeting_url": "https://meet.google.com/abc-defg-hij?authuser=0", "capture_mode": "audio"
        })))
        .await;
        assert!(s == StatusCode::CREATED || s == StatusCode::OK, "{m}");
        m["id"].as_str().unwrap().to_owned()
    }

    async fn chunk(&self, token: &str, id: &str, seq: u32, bytes: &[u8]) -> (StatusCode, Value) {
        self.call(
            Request::put(format!("/v1/meetings/{id}/chunks/{seq}"))
                .header("authorization", format!("Bearer {token}"))
                .header("x-chunk-sha256", ids::sha256_hex(bytes))
                .header("x-chunk-start-ms", (seq as u64 * 30_000).to_string())
                .header("x-chunk-duration-ms", "30000")
                .body(Body::from(bytes.to_vec()))
                .unwrap(),
        )
        .await
    }

    async fn finalize(
        &self,
        token: &str,
        id: &str,
        last: u32,
        allow_missing: bool,
    ) -> (StatusCode, Value) {
        self.call(json_req("POST", &format!("/v1/meetings/{id}/finalize"), Some(token), &json!({
            "last_seq": last, "stop_reason": "meeting_ended", "ended_at": Utc::now(), "allow_missing": allow_missing
        })))
        .await
    }

    async fn drain(&self, now: chrono::DateTime<Utc>) {
        while worker::run_once(&self.state, now).await.unwrap() {}
    }

    async fn drop_db(self) {
        self.state.db.close().await;
        let admin = sqlx::PgPool::connect(&self.admin_url).await.unwrap();
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.db_name))
            .execute(&admin)
            .await
            .unwrap();
    }
}

fn json_req(method: &str, uri: &str, token: Option<&str>, body: &Value) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap()
}

fn get_req(uri: &str, token: &str) -> Request<Body> {
    Request::get(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn client_pairing() -> Value {
    json!({
        "request_id": Uuid::new_v4().to_string(), "tenant_id": TENANT, "pairing_kind": "client_intake",
        "client_id": CLIENT, "intake_receipt_id": RECEIPT, "client_display_name": "Acme Ltd", "ttl_seconds": 600
    })
}

fn ogg(n: u8) -> Vec<u8> {
    let mut v = b"OggS\0\x02".to_vec();
    v.extend(std::iter::repeat_n(n, 64));
    v
}

fn calari() -> Shared {
    Arc::new(Mutex::new(Mock::default()))
}

#[tokio::test]
async fn full_flow_delivers_a_signed_ordered_transcript() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let token = h.device(client_pairing()).await;
    let id = h.meeting(&token, "k1").await;
    // Uploaded out of order; the transcript must still be in order.
    for seq in [2, 0, 1] {
        let (s, v) = h.chunk(&token, &id, seq, &ogg(seq as u8)).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
    }
    let (s, v) = h.finalize(&token, &id, 2, false).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{v}");
    h.drain(Utc::now()).await;

    let received = h.calari.lock().unwrap().received.clone();
    assert_eq!(received.len(), 1);
    let (headers, body) = &received[0];
    let payload: DeliveryPayload = serde_json::from_slice(body).unwrap();
    assert_eq!(payload.client_id.as_deref(), Some(CLIENT));
    assert_eq!(payload.intake_receipt_id.as_deref(), Some(RECEIPT));
    assert_eq!(payload.tenant_id, TENANT);
    assert_eq!(
        payload.meeting.meeting_url.as_deref(),
        Some("https://meet.google.com/abc-defg-hij")
    );
    assert_eq!(
        payload.meeting.provider_hint.as_deref(),
        Some("google_meet")
    );
    assert!(!payload.meeting.partial);
    assert!(payload.summary.is_none());
    let starts: Vec<u64> = payload
        .transcript
        .segments
        .iter()
        .map(|s| s.start_ms)
        .collect();
    assert_eq!(starts, vec![0, 30_000, 60_000]);
    assert!(payload
        .transcript
        .text
        .contains("not real speech recognition"));
    assert_eq!(
        headers[signing::HEADER_DELIVERY_ID].to_str().unwrap(),
        payload.event_id
    );

    let (s, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &token)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["state"], "delivered");
    assert_eq!(v["delivery"]["receipt_id"], "rcpt-1");
    h.drop_db().await;
}

#[tokio::test]
async fn pairing_requests_are_authenticated_fresh_and_tenant_bound() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let body = client_pairing();
    let now = Utc::now().timestamp();

    let replayed = h.signed(&body, "nonce-replay-000001", now, signing::Purpose::Pairing);
    assert_eq!(h.call(replayed).await.0, StatusCode::CREATED);
    let again = h.signed(&body, "nonce-replay-000001", now, signing::Purpose::Pairing);
    assert_eq!(h.call(again).await.1["error"], "replayed_nonce");

    let stale = h.signed(
        &client_pairing(),
        "nonce-stale-0000001",
        now - 301,
        signing::Purpose::Pairing,
    );
    assert_eq!(
        h.call(stale).await,
        (StatusCode::UNAUTHORIZED, json!({"error": "stale_request"}))
    );

    let wrong_purpose = h.signed(
        &client_pairing(),
        "nonce-purpose-00001",
        now,
        signing::Purpose::Delivery,
    );
    assert_eq!(h.call(wrong_purpose).await.0, StatusCode::UNAUTHORIZED);

    let mut tampered = h.signed(
        &client_pairing(),
        "nonce-tamper-000001",
        now,
        signing::Purpose::Pairing,
    );
    *tampered.body_mut() = Body::from(serde_json::to_vec(&client_pairing()).unwrap());
    assert_eq!(h.call(tampered).await.0, StatusCode::UNAUTHORIZED);

    let mut other_tenant = client_pairing();
    other_tenant["tenant_id"] = json!("00000000-0000-4000-8000-0000000000ff");
    assert_eq!(
        h.pair(&other_tenant).await,
        (StatusCode::FORBIDDEN, json!({"error": "tenant_mismatch"}))
    );

    let mut by_name = client_pairing();
    by_name["client_id"] = json!("Acme Ltd");
    assert_eq!(h.pair(&by_name).await.0, StatusCode::BAD_REQUEST);

    let mut unknown_field = client_pairing();
    unknown_field["role"] = json!("admin");
    assert_eq!(h.pair(&unknown_field).await.0, StatusCode::BAD_REQUEST);

    let unsigned = json_req("POST", "/v1/pairings", None, &client_pairing());
    assert_eq!(h.call(unsigned).await.0, StatusCode::UNAUTHORIZED);
    h.drop_db().await;
}

#[tokio::test]
async fn pairing_retries_are_idempotent_and_codes_single_use() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let body = client_pairing();
    let (s1, first) = h.pair(&body).await;
    let (s2, second) = h.pair(&body).await; // lost response, retried with a fresh nonce
    assert_eq!((s1, s2), (StatusCode::CREATED, StatusCode::OK));
    assert_eq!(first, second);

    let mut changed = body.clone();
    changed["client_id"] = json!("00000000-0000-4000-8000-0000000000aa");
    assert_eq!(h.pair(&changed).await.1["error"], "request_conflict");

    let code = first["code"].as_str().unwrap();
    assert_eq!(
        h.redeem(&code.to_lowercase().replace('-', " ")).await.0,
        StatusCode::OK
    );
    assert_eq!(
        h.redeem(code).await,
        (StatusCode::NOT_FOUND, json!({"error": "pairing_invalid"}))
    );
    assert_eq!(h.pair(&body).await.1["error"], "pairing_unavailable");

    // Expired codes look exactly like wrong ones.
    let (_, p) = h.pair(&client_pairing()).await;
    sqlx::query(
        "UPDATE meeting_pairings SET expires_at = now() - interval '1 second' WHERE id = $1::uuid",
    )
    .bind(p["pairing_id"].as_str().unwrap())
    .execute(&h.state.db)
    .await
    .unwrap();
    assert_eq!(
        h.redeem(p["code"].as_str().unwrap()).await.1["error"],
        "pairing_invalid"
    );

    // Guessing is rate limited.
    for _ in 0..20 {
        h.redeem("0000-0000").await;
    }
    let (_, fresh) = h.pair(&client_pairing()).await;
    assert_eq!(
        h.redeem(fresh["code"].as_str().unwrap()).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    h.drop_db().await;
}

#[tokio::test]
async fn device_tokens_only_reach_their_own_meetings() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let a = h.device(client_pairing()).await;
    let mut other = client_pairing();
    other["client_id"] = json!("00000000-0000-4000-8000-0000000000bb");
    let b = h.device(other).await;
    let a_meeting = h.meeting(&a, "same-key").await;
    let b_meeting = h.meeting(&b, "same-key").await;
    assert_ne!(a_meeting, b_meeting);
    assert_eq!(
        h.meeting(&a, "same-key").await,
        a_meeting,
        "create is idempotent per token"
    );

    for (uri, method) in [(format!("/v1/meetings/{a_meeting}"), "GET")] {
        let req = Request::builder()
            .method(method)
            .uri(&uri)
            .header("authorization", format!("Bearer {b}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(h.call(req).await.0, StatusCode::NOT_FOUND);
    }
    assert_eq!(
        h.chunk(&b, &a_meeting, 0, &ogg(1)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.finalize(&b, &a_meeting, 0, true).await.0,
        StatusCode::NOT_FOUND
    );
    let ev = json_req(
        "POST",
        &format!("/v1/meetings/{a_meeting}/events"),
        Some(&b),
        &json!({"kind": "idle_warning", "at": Utc::now()}),
    );
    assert_eq!(h.call(ev).await.0, StatusCode::NOT_FOUND);

    // A device cannot name a different client when creating a meeting.
    let sneaky = json_req(
        "POST",
        "/v1/meetings",
        Some(&b),
        &json!({
            "title": "x", "idempotency_key": "k9", "started_at": Utc::now(), "client_id": CLIENT
        }),
    );
    assert!(h.call(sneaky).await.0.is_client_error());

    let bogus = format!("capdev_{}", "0".repeat(64));
    assert_eq!(
        h.call(get_req(&format!("/v1/meetings/{a_meeting}"), &bogus))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE meeting_devices SET expires_at = now() - interval '1 second'")
        .execute(&h.state.db)
        .await
        .unwrap();
    assert_eq!(
        h.call(get_req(&format!("/v1/meetings/{a_meeting}"), &a))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    h.drop_db().await;
}

#[tokio::test]
async fn chunks_are_validated_and_finalize_reports_gaps() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    assert_eq!(
        h.chunk(&t, &id, 0, b"<html><script>").await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let bad_sum = Request::put(format!("/v1/meetings/{id}/chunks/0"))
        .header("authorization", format!("Bearer {t}"))
        .header("x-chunk-sha256", ids::sha256_hex(b"other"))
        .header("x-chunk-start-ms", "0")
        .header("x-chunk-duration-ms", "30000")
        .body(Body::from(ogg(0)))
        .unwrap();
    assert_eq!(h.call(bad_sum).await.1["error"], "checksum_mismatch");
    assert_eq!(h.chunk(&t, &id, 0, &ogg(0)).await.0, StatusCode::CREATED);
    assert_eq!(
        h.chunk(&t, &id, 0, &ogg(0)).await,
        (StatusCode::OK, json!({"status": "duplicate"}))
    );
    assert_eq!(
        h.chunk(&t, &id, 0, &ogg(9)).await.1["error"],
        "chunk_conflict"
    );
    assert_eq!(h.chunk(&t, &id, 2, &ogg(2)).await.0, StatusCode::CREATED);
    assert_eq!(
        h.chunk(&t, &id, 5000, &ogg(2)).await.0,
        StatusCode::BAD_REQUEST
    );

    let (s, v) = h.finalize(&t, &id, 2, false).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(v["missing_chunks"], json!([1]));
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["missing_chunks"], json!([1]));
    assert_eq!(
        h.finalize(&t, &id, 1, false).await.1["error"],
        "chunks_after_last_seq"
    );

    assert_eq!(h.finalize(&t, &id, 2, true).await.0, StatusCode::ACCEPTED);
    assert_eq!(
        h.finalize(&t, &id, 2, true).await.0,
        StatusCode::ACCEPTED,
        "finalize is idempotent"
    );
    assert_eq!(
        h.chunk(&t, &id, 1, &ogg(1)).await.1["error"],
        "meeting_not_recording"
    );
    h.drain(Utc::now()).await;
    let payload: DeliveryPayload =
        serde_json::from_slice(&h.calari.lock().unwrap().received[0].1).unwrap();
    assert!(payload.meeting.partial);
    assert_eq!(payload.transcript.segments.len(), 2);
    h.drop_db().await;
}

#[tokio::test]
async fn delivery_retries_resend_identical_bytes_with_fresh_nonces() {
    let shared = calari();
    shared.lock().unwrap().script.extend([503, 429]);
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, shared).await else {
        return;
    };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    h.chunk(&t, &id, 0, &ogg(0)).await;
    h.finalize(&t, &id, 0, false).await;
    let mut now = Utc::now();
    for _ in 0..3 {
        h.drain(now).await;
        now += chrono::Duration::hours(1);
    }
    let received = h.calari.lock().unwrap().received.clone();
    assert_eq!(received.len(), 3);
    assert!(
        received.windows(2).all(|w| w[0].1 == w[1].1),
        "body bytes are frozen"
    );
    let nonces: std::collections::HashSet<_> = received
        .iter()
        .map(|(hd, _)| hd[signing::HEADER_NONCE].to_str().unwrap().to_owned())
        .collect();
    assert_eq!(nonces.len(), 3);
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_delivery_attempts")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert_eq!(attempts, 3);
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["state"], "delivered");
    assert_eq!(v["delivery"]["attempts"], 3);
    h.drop_db().await;
}

#[tokio::test]
async fn rejected_delivery_fails_visibly_and_operator_can_retry() {
    let shared = calari();
    shared.lock().unwrap().script.push_back(403);
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, shared).await else {
        return;
    };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    h.chunk(&t, &id, 0, &ogg(0)).await;
    h.finalize(&t, &id, 0, false).await;
    h.drain(Utc::now()).await;
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["state"], "failed");
    assert_eq!(v["delivery"]["status"], "failed");
    assert!(v["failure"].as_str().unwrap().contains("403"));

    worker::retry_failed(&h.state, Uuid::parse_str(&id).unwrap())
        .await
        .unwrap();
    h.drain(Utc::now()).await;
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["state"], "delivered");
    let r = h.calari.lock().unwrap().received.clone();
    assert_eq!(r[0].1, r[1].1, "retry re-sends the same event");
    h.drop_db().await;
}

#[tokio::test]
async fn transcription_retries_never_repeat_finished_chunks() {
    let whisper = calari();
    // Chunk 0 succeeds, chunk 1 hits a 503, then everything succeeds.
    whisper.lock().unwrap().script.extend([200, 503]);
    let url = mock_whisper(whisper.clone()).await;
    let cfg = TranscriptionConfig::OpenAiCompatible {
        base_url: url,
        api_key: None,
        model: "whisper-1".into(),
    };
    let Some(h) = Harness::new(cfg, calari()).await else {
        return;
    };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    for seq in 0..3 {
        h.chunk(&t, &id, seq, &ogg(seq as u8)).await;
    }
    h.finalize(&t, &id, 2, false).await;
    h.drain(Utc::now()).await;
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["state"], "transcribing");
    h.drain(Utc::now() + chrono::Duration::hours(1)).await;
    let calls = whisper.lock().unwrap().calls.clone();
    assert_eq!(
        calls,
        vec!["chunk-0.ogg", "chunk-1.ogg", "chunk-1.ogg", "chunk-2.ogg"]
    );
    let payload: DeliveryPayload =
        serde_json::from_slice(&h.calari.lock().unwrap().received[0].1).unwrap();
    let starts: Vec<u64> = payload
        .transcript
        .segments
        .iter()
        .map(|s| s.start_ms)
        .collect();
    assert_eq!(starts, vec![500, 30_500, 60_500]);
    assert_eq!(payload.transcript.provider, "openai-compatible");
    h.drop_db().await;
}

#[tokio::test]
async fn abandoned_recordings_are_finalized_with_the_audio_that_arrived() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    h.chunk(&t, &id, 0, &ogg(0)).await;
    h.drain(Utc::now()).await;
    assert!(
        h.calari.lock().unwrap().received.is_empty(),
        "an active recording is left alone"
    );
    h.drain(Utc::now() + chrono::Duration::hours(2)).await;
    let payload: DeliveryPayload =
        serde_json::from_slice(&h.calari.lock().unwrap().received[0].1).unwrap();
    assert_eq!(
        payload.meeting.stop_reason,
        cap_meeting_protocol::StopReason::Interrupted
    );
    assert!(payload.meeting.partial);
    h.drop_db().await;
}

#[tokio::test]
async fn internal_team_meetings_carry_no_client() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else {
        return;
    };
    let body = json!({
        "request_id": Uuid::new_v4().to_string(), "tenant_id": TENANT, "pairing_kind": "internal_team", "ttl_seconds": 300
    });
    let t = h.device(body).await;
    let id = h.meeting(&t, "k").await;
    h.chunk(&t, &id, 0, &ogg(0)).await;
    h.finalize(&t, &id, 0, false).await;
    h.drain(Utc::now()).await;
    let payload: DeliveryPayload =
        serde_json::from_slice(&h.calari.lock().unwrap().received[0].1).unwrap();
    assert_eq!(payload.client_id, None);
    assert_eq!(payload.intake_receipt_id, None);
    assert_eq!(
        payload.context.pairing_kind,
        cap_meeting_protocol::PairingKind::InternalTeam
    );
    h.drop_db().await;
}

/// Server review 1: a worker whose lease expired and was taken over can no
/// longer change the meeting.
#[tokio::test]
async fn an_expired_worker_lease_is_fenced_out() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else { return };
    let t = h.device(client_pairing()).await;
    let id = h.meeting(&t, "k").await;
    h.chunk(&t, &id, 0, &ogg(0)).await;
    h.finalize(&t, &id, 0, false).await;
    let now = Utc::now();
    let a = worker::claim(&h.state, now).await.unwrap().expect("worker A claims");
    assert!(worker::claim(&h.state, now).await.unwrap().is_none(), "a live lease is exclusive");
    let b = worker::claim(&h.state, now + chrono::Duration::minutes(16)).await.unwrap().expect("worker B takes over");
    assert_ne!(a.token, b.token);

    // The stale worker wakes up and tries to work: nothing changes.
    worker::work(&h.state, a, now).await.unwrap();
    let (state, token): (String, Option<Uuid>) =
        sqlx::query_as("SELECT state, lease_token FROM meeting_sessions WHERE id = $1::uuid")
            .bind(&id)
            .fetch_one(&h.state.db)
            .await
            .unwrap();
    assert_eq!(state, "finalized");
    assert_eq!(token, Some(b.token), "the stale worker did not clear the new lease");
    assert!(a.renew(&h.state).await.is_err());
    assert!(h.calari.lock().unwrap().received.is_empty());

    worker::work(&h.state, b, now).await.unwrap();
    let (_, v) = h.call(get_req(&format!("/v1/meetings/{id}"), &t)).await;
    assert_eq!(v["state"], "delivered");
    assert_eq!(h.calari.lock().unwrap().received.len(), 1);
    h.drop_db().await;
}

/// Server review 2: a chunk still being stored when the meeting is
/// finalized (or swept as abandoned) is refused, never silently dropped.
#[tokio::test]
async fn an_upload_racing_finalize_or_abandon_is_refused() {
    let Some(h) = Harness::new(TranscriptionConfig::TestFixture, calari()).await else { return };
    let mut slow = h.state.clone();
    slow.store = cap_server::store::ObjectStore::Delayed(Box::new(h.state.store.clone()), Duration::from_millis(800));
    let put = |token: &str, id: &str, seq: u32| {
        let bytes = ogg(seq as u8);
        Request::put(format!("/v1/meetings/{id}/chunks/{seq}"))
            .header("authorization", format!("Bearer {token}"))
            .header("x-chunk-sha256", ids::sha256_hex(&bytes))
            .header("x-chunk-start-ms", (seq as u64 * 30_000).to_string())
            .header("x-chunk-duration-ms", "30000")
            .body(Body::from(bytes))
            .unwrap()
    };
    for race_with_abandon in [false, true] {
        let t = h.device(client_pairing()).await;
        let id = h.meeting(&t, if race_with_abandon { "abandon" } else { "finalize" }).await;
        assert_eq!(h.chunk(&t, &id, 0, &ogg(0)).await.0, StatusCode::CREATED);
        let upload = router(slow.clone()).oneshot(put(&t, &id, 1));
        let transition = async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if race_with_abandon {
                worker::run_once(&h.state, Utc::now() + chrono::Duration::hours(2)).await.unwrap();
            } else {
                assert_eq!(h.finalize(&t, &id, 0, false).await.0, StatusCode::ACCEPTED);
            }
        };
        let (res, ()) = tokio::join!(upload, transition);
        let res = res.unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT, "abandon={race_with_abandon}");
        let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_chunks WHERE meeting_id = $1::uuid AND seq = 1")
            .bind(&id)
            .fetch_one(&h.state.db)
            .await
            .unwrap();
        assert_eq!(stored, 0);
    }
    h.drop_db().await;
}

/// Server review 3: decoding is bounded by real audio length, not by the
/// duration the client claimed.
#[tokio::test]
async fn overlong_compressed_audio_is_rejected_while_decoding() {
    let Ok(ffmpeg) = std::env::var("CAP_TEST_FFMPEG") else {
        eprintln!("SKIPPED: set CAP_TEST_FFMPEG");
        return;
    };
    let make = |seconds: u32| {
        let path = format!("/tmp/cap-decode-{}.ogg", Uuid::new_v4());
        let ok = std::process::Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", &format!("anullsrc=r=48000:cl=mono:d={seconds}")])
            .args(["-c:a", "libopus", "-b:a", "8k", &path])
            .stdin(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        bytes
    };
    use cap_server::meetings::transcribe::{decode_pcm16k, DECODE_SLACK_MS};
    // Twenty minutes of audio in a small file that claims to be 30 seconds.
    let long = make(1_200);
    assert!(long.len() < 2 << 20, "compressed size {}", long.len());
    let err = decode_pcm16k(&ffmpeg, &long, 30_000 + DECODE_SLACK_MS).await.unwrap_err();
    assert!(err.to_string().contains("more than"), "{err}");
    let ok = decode_pcm16k(&ffmpeg, &make(5), 5_000 + DECODE_SLACK_MS).await.unwrap();
    assert!((70_000..=90_000).contains(&ok.len()), "{} samples", ok.len());
}
