//! Composite gate: real local Cap + real local Calari (calendar adapter,
//! receiver and worker, from the portal owner's worktree) + the real runner
//! container + real Whisper. Google Calendar and Google Meet are FIXTURES
//! (local stand-ins); Calari's AI step uses the portal kit's local AI fixture.
//! Opt-in, local only:
//!
//!   CAP_COMPOSITE_KIT=/home/don/code/calari-cap-calendar/test-results/cap-calendar-composite \
//!   CAP_TEST_DATABASE_URL=postgres://… CAP_TEST_BOT_IMAGE=cap-meeting-bot:calendar-test \
//!   CAP_TEST_WHISPER_MODEL=~/.cache/cap-whisper/ggml-tiny.en.bin \
//!   cargo test -p cap-meeting-bot --features fake-meet,cap-server/local-whisper --test composite -- --nocapture

#![allow(clippy::unwrap_used)]

mod support;

use cap_meeting_protocol::{CalendarPairingRequest, PairingKind};
use cap_server::attendance::calari::{self, CalariError};
use serde_json::json;
use support::calendar::External;
use support::*;

const CALARI: &str = "http://127.0.0.1:4100/api/v1/integrations/cap";
const ACME: &str = "Demo Acme Dental";

fn verify(kit: &str) -> Value {
    let out = Command::new(format!("{kit}/verify.sh")).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

/// Forwards deliveries to Calari; the FIRST answer Cap sees is replaced by a
/// 503 after Calari already accepted it, so Cap must retry and Calari must
/// recognise the same delivery.
#[derive(Default)]
struct DeliveryProxy {
    target: String,
    seen: AtomicUsize,
    calari_statuses: Mutex<Vec<u16>>,
}

async fn deliver_proxy(target: String) -> (Arc<DeliveryProxy>, String) {
    let p = Arc::new(DeliveryProxy {
        target,
        ..Default::default()
    });
    let pp = p.clone();
    let app = Router::new().route(
        "/",
        post(move |headers: HeaderMap, body: Bytes| {
            let p = pp.clone();
            async move {
                let mut req = reqwest::Client::new().post(&p.target);
                for (k, v) in &headers {
                    if k != "host" && k != "content-length" {
                        req = req.header(k.as_str(), v.as_bytes());
                    }
                }
                let res = req.body(body.to_vec()).send().await.unwrap();
                let status = res.status().as_u16();
                let text = res.text().await.unwrap();
                p.calari_statuses.lock().unwrap().push(status);
                let n = p.seen.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    (StatusCode::SERVICE_UNAVAILABLE, String::new())
                } else {
                    (StatusCode::from_u16(status).unwrap(), text)
                }
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (p, url)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_calari_composite_routes_records_and_delivers_once() {
    let (Ok(kit), Ok(image)) = (
        std::env::var("CAP_COMPOSITE_KIT"),
        std::env::var("CAP_TEST_BOT_IMAGE"),
    ) else {
        eprintln!("SKIPPED: set CAP_COMPOSITE_KIT and CAP_TEST_BOT_IMAGE (local composite only)");
        return;
    };
    let ids: Value =
        serde_json::from_slice(&std::fs::read(format!("{kit}/fixture-ids.json")).unwrap()).unwrap();
    let secret_text = std::fs::read_to_string(format!("{kit}/cap-secret.b64url")).unwrap();
    let secret = cap_meeting_protocol::signing::decode_secret(secret_text.trim()).unwrap();
    let admin_id = ids["admin"]["id"].as_str().unwrap().to_owned();
    let admin_email = ids["admin"]["email"].as_str().unwrap().to_owned();
    let client_id = |name: &str| {
        ids["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let acme = Uuid::parse_str(&client_id(ACME)).unwrap();
    let beta = Uuid::parse_str(&client_id("Demo Beta Builders")).unwrap();

    let (dp, dp_url) = deliver_proxy(format!("{CALARI}/meetings")).await;
    let (t, real_whisper) = transcription();
    let Some(w) = World::with_external(
        t,
        90,
        External {
            cap_port: 8789,
            key_id: ids["key_id"].as_str().unwrap().into(),
            tenant_id: ids["tenant_id"].as_str().unwrap().into(),
            secret,
            delivery_url: dp_url,
            authorize_url: "http://127.0.0.1:3100/portal/cap/authorize".into(),
            exchange_url: format!("{CALARI}/login/exchange"),
            status_url: format!("{CALARI}/login/status"),
            resolve_url: format!("{CALARI}/calendar/resolve"),
            pairing_url: format!("{CALARI}/calendar/pairing"),
        },
    )
    .await
    else {
        return;
    };
    let before = verify(&kit);
    let meetings_before = before["meetings"].as_array().unwrap().len();
    let pairings_before = before["calendarPairings"].as_array().unwrap().len();

    // Staff session: every request asks the real Calari (signed status).
    let admin = w.seed_session(&admin_id, &admin_email, true).await;
    let res = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &admin.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "real Calari confirmed the staff member");
    w.connect(&admin, &admin_email).await; // Google fixture

    let now = Utc::now();
    let later = now + Duration::hours(2);
    {
        let mut g = w.google.lock().unwrap();
        g.add(
            &admin_email,
            event(
                "acme",
                now + Duration::seconds(30),
                30,
                "abc-defg-hij",
                &["pat.lee@acme-dental.example"],
            ),
        );
        // Same meeting twice in the calendar: one bot only.
        g.add(
            &admin_email,
            event(
                "acme-copy",
                now + Duration::seconds(30),
                30,
                "abc-defg-hij",
                &["office@acme-dental.example"],
            ),
        );
        g.add(
            &admin_email,
            event(
                "ambiguous",
                later,
                30,
                "amb-ambi-amb",
                &["shared.consultant@example.com"],
            ),
        );
        g.add(
            &admin_email,
            event(
                "unmapped",
                later,
                30,
                "unm-unma-unm",
                &["nobody@unmapped.example"],
            ),
        );
        g.add(
            &admin_email,
            event(
                "archived",
                later,
                30,
                "arc-arch-arc",
                &["former@archived.example"],
            ),
        );
    }
    w.sync(Utc::now()).await;
    w.sync(Utc::now()).await;
    let atts = w.attendances().await;
    eprintln!("attendances after sync: {atts:?}");
    assert_eq!(
        atts.len(),
        1,
        "only the exact Acme mapping schedules; duplicates collapse"
    );
    assert_eq!((atts[0].2.as_str(), atts[0].3), ("client", Some(acme)));
    let cand = |id: &str| {
        let db = w.state.db.clone();
        let id = id.to_owned();
        async move {
            sqlx::query_scalar::<_, Value>(
                "SELECT candidates FROM calendar_events WHERE event_id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let amb = cand("ambiguous").await;
    let amb_clients: std::collections::BTreeSet<String> = amb
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["client_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        amb_clients,
        [acme.to_string(), beta.to_string()].into_iter().collect(),
        "{amb}"
    );
    assert_eq!(
        cand("unmapped").await,
        json!([]),
        "unmapped: no client, never internal"
    );
    assert_eq!(
        cand("archived").await,
        json!([]),
        "archived client withheld by Calari"
    );
    let page = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &admin.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Choose a client"));

    // Explicit staff choice for the ambiguous meeting (a client Calari offered).
    let res = w
        .post_form(
            &admin,
            "/calendar/choice",
            &[
                ("event_id", "ambiguous"),
                ("choice", &format!("client:{beta}")),
            ],
        )
        .await;
    assert_eq!(res.status(), 303);
    let n_beta: i64 =
        sqlx::query_scalar("SELECT count(*) FROM calendar_attendances WHERE client_id = $1")
            .bind(beta)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(n_beta, 1);

    // Pairing from the real Calari, as the staff member, once.
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let (att, st, version): (Uuid, String, i32) = sqlx::query_as(
        "SELECT id, state, version FROM calendar_attendances WHERE meet_code = 'abc-defg-hij'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(
        st,
        "ready",
        "{:?}",
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT failure FROM calendar_attendances WHERE id = $1"
        )
        .bind(att)
        .fetch_one(&w.state.db)
        .await
        .unwrap()
    );
    let after_pairing = verify(&kit);
    let new_pairings = &after_pairing["calendarPairings"].as_array().unwrap()[pairings_before..];
    eprintln!("new Calari calendar pairings: {new_pairings:?}");
    assert_eq!(new_pairings.len(), 1, "one pairing for one meeting");
    assert_eq!(new_pairings[0]["kind"], "staff_client");
    assert_eq!(new_pairings[0]["client"], ACME);

    // Calari's own strictness, called directly with Cap's signed client.
    let tenant = ids["tenant_id"].as_str().unwrap();
    let base = |client: Option<Uuid>, kind: PairingKind, request: Uuid, title: &str| {
        CalendarPairingRequest {
            request_id: request.to_string(),
            user_id: admin_id.clone(),
            pairing_kind: kind,
            client_id: client.map(|c| c.to_string()),
            title: title.into(),
            starts_at: Utc::now() + Duration::minutes(5),
            ends_at: Utc::now() + Duration::minutes(35),
        }
    };
    let r = calari::request_pairing(
        &w.state,
        tenant,
        &base(
            Some(Uuid::new_v4()),
            PairingKind::StaffClient,
            Uuid::new_v4(),
            "x",
        ),
    )
    .await;
    assert_eq!(
        r.err(),
        Some(CalariError::Refused),
        "unknown client refused"
    );
    let r = calari::request_pairing(
        &w.state,
        tenant,
        &base(Some(acme), PairingKind::InternalTeam, Uuid::new_v4(), "x"),
    )
    .await;
    assert_eq!(
        r.err(),
        Some(CalariError::Refused),
        "internal with a client refused"
    );
    let r = calari::request_pairing(
        &w.state,
        tenant,
        &base(None, PairingKind::StaffClient, Uuid::new_v4(), "x"),
    )
    .await;
    assert_eq!(
        r.err(),
        Some(CalariError::Refused),
        "client meeting without client refused"
    );
    let reused = attendance::schedule::pairing_request_id(att, version);
    let r = calari::request_pairing(
        &w.state,
        tenant,
        &base(
            Some(acme),
            PairingKind::StaffClient,
            reused,
            "Different body",
        ),
    )
    .await;
    assert_eq!(
        r.err(),
        Some(CalariError::Refused),
        "same request id, different body refused"
    );
    let mut other_staff = base(Some(acme), PairingKind::StaffClient, Uuid::new_v4(), "x");
    other_staff.user_id = "cl-not-a-staff-member-000000".into();
    assert_eq!(
        calari::request_pairing(&w.state, tenant, &other_staff)
            .await
            .err(),
        Some(CalariError::Refused),
        "unknown staff refused"
    );
    let after_refusals = verify(&kit);
    assert_eq!(
        after_refusals["calendarPairings"].as_array().unwrap().len(),
        pairings_before + 1,
        "refusals created nothing"
    );

    // The runner attends the fixture meeting and records the speech.
    let seen = Arc::new(Mutex::new(Vec::new()));
    let meet = fake_meet(seen.clone(), false).await;
    let volume = Volume(format!("cap-bot-spool-{}", Uuid::new_v4().simple()));
    let c = start_runner(&image, &w.cap, &meet, &volume.0);
    let st = wait_for(&w, att, &["completed", "failed"], 240).await;
    eprintln!("runner log:\n{}", logs(&c));
    eprintln!("page events: {:?}", seen.lock().unwrap());
    assert_eq!(st, "completed");
    drop(c);

    // Delivery: Calari accepts, Cap is told 503, Cap retries, Calari dedupes.
    while worker::run_once(&w.state, Utc::now()).await.unwrap() {}
    let retry_at = Utc::now() + Duration::minutes(10);
    while worker::run_once(&w.state, retry_at).await.unwrap() {}
    let statuses = dp.calari_statuses.lock().unwrap().clone();
    eprintln!("Calari delivery answers: {statuses:?}");
    assert!(statuses.len() >= 2, "delivery was retried");
    assert!(
        statuses.iter().all(|s| (200..300).contains(s)),
        "Calari accepted both, recognising the repeat"
    );
    let (status, receipt): (String, Option<String>) =
        sqlx::query_as("SELECT status, receipt_id FROM meeting_deliveries")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(status, "delivered");
    eprintln!("Calari receipt: {receipt:?}");
    // Running the worker again sends nothing more.
    while worker::run_once(&w.state, Utc::now() + Duration::hours(1))
        .await
        .unwrap()
    {}
    assert_eq!(dp.seen.load(Ordering::SeqCst), statuses.len());

    // Calari: one meeting, bound to Acme, with notes and a task, exactly once.
    let mut last = Value::Null;
    for _ in 0..180 {
        last = verify(&kit);
        let ms = &last["meetings"].as_array().unwrap()[meetings_before..];
        if ms.len() == 1
            && !ms[0]["summary"].is_null()
            && !ms[0]["tasks"].as_array().unwrap().is_empty()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    eprintln!(
        "Calari verify: {}",
        serde_json::to_string_pretty(&last).unwrap()
    );
    let ms = &last["meetings"].as_array().unwrap()[meetings_before..];
    assert_eq!(ms.len(), 1, "one Calari meeting");
    let m = &ms[0];
    assert_eq!(m["client"], ACME);
    assert_eq!(
        m["deliveriesForExternalId"], 1,
        "one delivery row despite the retry"
    );
    assert!(!m["summary"].is_null(), "notes written");
    let tasks = m["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "one task");
    assert_eq!(tasks[0]["client"]["name"], ACME, "task bound to the client");
    if real_whisper {
        let summary = m["summary"].as_str().unwrap().to_lowercase();
        eprintln!("summary (AI fixture quoting the real transcript): {summary}");
    }
    let joins = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v["k"] == "join")
        .count();
    assert_eq!(joins, 1);

    // Revocation: disconnect → Google fixture revoke, credential gone,
    // the Beta attendance cancelled, no further pairing.
    let n = w.google.lock().unwrap().revoke_calls.len();
    assert_eq!(
        w.post_form(&admin, "/calendar/disconnect", &[])
            .await
            .status(),
        303
    );
    assert_eq!(w.google.lock().unwrap().revoke_calls.len(), n + 1);
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_attendances WHERE state IN ('scheduled','preparing','ready')")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(live, 0);
    attendance::schedule::tick(&w.state, Utc::now() + Duration::hours(2))
        .await
        .unwrap();
    assert_eq!(
        verify(&kit)["calendarPairings"].as_array().unwrap().len(),
        pairings_before + 1
    );
    w.drop_db().await;
}
