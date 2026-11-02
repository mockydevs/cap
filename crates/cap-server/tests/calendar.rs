//! Calendar attendance end to end over real HTTP: OAuth (state, PKCE,
//! session/browser binding), encrypted storage, incremental sync with a
//! durable page cursor, scheduling (dedupe, reschedule, cancel, timezone),
//! Calari pairing, bot runner leases, and signed delivery.

#![allow(clippy::unwrap_used)]

mod support;

use cap_server::{attendance, config::TranscriptionConfig, meetings::worker};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use support::calendar::{event, World, TENANT};
use uuid::Uuid;

const DON: &str = "cldon000000000000000000001";
const AMY: &str = "clamy000000000000000000002";

async fn world() -> Option<World> {
    let w = World::new(TranscriptionConfig::TestFixture).await?;
    w.staff(DON, "don@calari.test");
    w.staff(AMY, "amy@calari.test");
    Some(w)
}

#[tokio::test]
async fn oauth_is_bound_to_state_pkce_session_and_browser() {
    let Some(w) = world().await else { return };
    let don = w.sign_in(DON).await;
    let amy = w.sign_in(AMY).await;

    // CSRF: no token, or a foreign origin, is refused.
    let res = w
        .http
        .post(format!("{}/calendar/connect", w.cap))
        .header("cookie", &don.cookie)
        .form(&[("csrf", "nope")])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let res = w
        .http
        .post(format!("{}/calendar/connect", w.cap))
        .header("cookie", &don.cookie)
        .header("origin", "https://evil.test")
        .form(&[("csrf", don.csrf.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    let (browser, q) = w.begin_connect(&don).await;
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["access_type"], "offline");
    assert_eq!(q["prompt"], "consent");
    assert_eq!(q["include_granted_scopes"], "false");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["code_challenge"].len(), 43);
    assert_eq!(
        q["redirect_uri"],
        format!("{}/calendar/google/callback", w.cap)
    );
    let scopes: Vec<&str> = q["scope"].split(' ').collect();
    assert!(scopes.contains(&"https://www.googleapis.com/auth/calendar.events.readonly"));
    assert!(
        !scopes
            .iter()
            .any(|s| s.contains("drive") || s.ends_with("/auth/calendar")),
        "read-only, no Drive"
    );
    let code = w.consent(&q, "don@calari.test");

    // Another staff member's session with Don's browser cookie: refused and
    // the attempt is not consumed.
    let res = w.callback(&amy, Some(&browser), &code, &q["state"]).await;
    assert_eq!(res.status(), 400);
    // Missing browser binding: refused.
    let res = w.callback(&don, None, &code, &q["state"]).await;
    assert_eq!(res.status(), 400);
    // Wrong state: refused.
    let res = w
        .callback(&don, Some(&browser), &code, "x".repeat(43).as_str())
        .await;
    assert_eq!(res.status(), 400);
    // The real one still works.
    let res = w.callback(&don, Some(&browser), &code, &q["state"]).await;
    assert_eq!(res.status(), 303, "{:?}", res.text().await);
    // Replay: single use.
    let res = w.callback(&don, Some(&browser), &code, &q["state"]).await;
    assert_eq!(res.status(), 400);

    // Stored encrypted, never in plaintext.
    let (ct, email, status): (Vec<u8>, String, String) = sqlx::query_as(
        "SELECT refresh_ciphertext, account_email, status FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(DON)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(
        (email.as_str(), status.as_str()),
        ("don@calari.test", "active")
    );
    let rt = w
        .google
        .lock()
        .unwrap()
        .refresh
        .keys()
        .next()
        .unwrap()
        .clone();
    assert!(!ct.windows(rt.len()).any(|win| win == rt.as_bytes()));
    let dump: String =
        sqlx::query_scalar("SELECT string_agg(t::text, '|') FROM calendar_connections t")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert!(!dump.contains(&rt));

    // A different Google account than the staff email: refused and revoked.
    let (b2, q2) = w.begin_connect(&amy).await;
    let c2 = w.consent(&q2, "someone-else@gmail.test");
    let res = w.callback(&amy, Some(&b2), &c2, &q2["state"]).await;
    assert_eq!(res.status(), 400);
    assert_eq!(w.google.lock().unwrap().revoke_calls.len(), 1);
    // Calendar scope declined: refused and revoked.
    w.google.lock().unwrap().grant_scope = "openid email".into();
    let (b3, q3) = w.begin_connect(&amy).await;
    let c3 = w.consent(&q3, "amy@calari.test");
    assert_eq!(
        w.callback(&amy, Some(&b3), &c3, &q3["state"])
            .await
            .status(),
        400
    );
    assert_eq!(w.google.lock().unwrap().revoke_calls.len(), 2);
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM calendar_connections WHERE calari_user_id = $1")
            .bind(AMY)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(n, 0);

    // Settings page shows only one's own connection.
    let page = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &don.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("don@calari.test") && page.contains("Disconnect Google Calendar"));
    let page = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &amy.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!page.contains("don@calari.test") && page.contains("Connect Google Calendar"));
    // Not signed in: sent to sign-in.
    let res = w
        .http
        .get(format!("{}/calendar", w.cap))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["location"], "/login");
    w.drop_db().await;
}

#[tokio::test]
async fn sync_resumes_pages_dedupes_reschedules_and_cancels() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    let beta = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    w.client("ops@beta.test", beta, "Beta <Co>");
    let don = w.sign_in(DON).await;
    let amy = w.sign_in(AMY).await;
    w.connect(&don, "don@calari.test").await;
    w.connect(&amy, "amy@calari.test").await;

    let now = Utc::now();
    let t = now + Duration::hours(3);
    {
        let mut g = w.google.lock().unwrap();
        g.add(
            "don@calari.test",
            event("acme", t, 30, "abc-defg-hij", &["CEO@acme.test"]),
        );
        // Nairobi time (+03:00) is stored as the same instant in UTC.
        let mut tz = event("tz", t, 30, "tzz-tzzz-tzz", &["ceo@acme.test"]);
        tz["start"]["dateTime"] = json!((t + Duration::hours(1))
            .with_timezone(&chrono::FixedOffset::east_opt(3 * 3600).unwrap())
            .to_rfc3339());
        tz["end"]["dateTime"] = json!((t + Duration::hours(2))
            .with_timezone(&chrono::FixedOffset::east_opt(3 * 3600).unwrap())
            .to_rfc3339());
        g.add("don@calari.test", tz);
        g.add(
            "don@calari.test",
            event(
                "ambiguous",
                t,
                30,
                "amb-ambi-amb",
                &["ceo@acme.test", "ops@beta.test"],
            ),
        );
        g.add(
            "don@calari.test",
            event("unknown", t, 30, "unk-unkn-unk", &["stranger@else.test"]),
        );
        let mut allday = event("allday", t, 30, "all-dayy-all", &["ceo@acme.test"]);
        allday["start"] = json!({"date": "2026-11-20"});
        allday["end"] = json!({"date": "2026-11-21"});
        g.add("don@calari.test", allday);
        g.add(
            "don@calari.test",
            event("nomeet", t, 30, "x", &["ceo@acme.test"]),
        );
        // Amy has the same Acme meeting (same code, same start).
        g.add(
            "amy@calari.test",
            event("amy-copy", t, 30, "abc-defg-hij", &["ceo@acme.test"]),
        );
        // Page 2 of the first full sync fails once.
        g.fail_paged = Some((1, 500));
    }
    w.sync(now).await;
    // Don's run stopped after page 1 with the page cursor stored.
    let (page, run): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT page_token, sync_run_token FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(DON)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    // The durable cursor survived the failure.
    assert_eq!(page.as_deref(), Some("p2"));
    assert!(run.unwrap().starts_with("w:"));
    w.sync(now).await;
    {
        let g = w.google.lock().unwrap();
        // Every page of a run repeats its first page's bounded window.
        for q in g
            .event_requests
            .iter()
            .filter(|q| q.contains_key("pageToken"))
        {
            assert!(g.event_requests.iter().any(|f| !f.contains_key("pageToken")
                && f["timeMin"] == q["timeMin"]
                && f["timeMax"] == q["timeMax"]));
        }
        assert!(
            g.event_requests
                .iter()
                .filter(|q| q.get("pageToken").map(String::as_str) == Some("p2"))
                .count()
                >= 2,
            "page 2 retried, not restarted"
        );
    }
    let tokens: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT sync_run_token, page_token FROM calendar_connections ORDER BY calari_user_id",
    )
    .fetch_all(&w.state.db)
    .await
    .unwrap();
    assert!(
        tokens.iter().all(|(s, p)| s.is_none() && p.is_none()),
        "{tokens:?}"
    );

    let atts = w.attendances().await;
    // acme (deduplicated with Amy's copy) and tz; ambiguous/unknown need review; all-day and non-Meet ignored.
    assert_eq!(atts.len(), 2, "{atts:?}");
    assert!(atts
        .iter()
        .all(|a| a.1 == "scheduled" && a.2 == "client" && a.3 == Some(acme)));
    let tz_start: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT starts_at FROM calendar_attendances WHERE meet_code = 'tzz-tzzz-tzz'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(tz_start.timestamp(), (t + Duration::hours(1)).timestamp());
    let linked: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_events WHERE attendance_id = (SELECT id FROM calendar_attendances WHERE meet_code = 'abc-defg-hij')").fetch_one(&w.state.db).await.unwrap();
    assert_eq!(linked, 2, "both calendars point at one attendance");
    let page = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &don.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Choose a client"), "ambiguous meetings ask");
    assert!(page.contains("Beta &lt;Co&gt;"), "client names are escaped");

    // Staff choice resolves the ambiguous meeting; only offered clients count.
    let res = w
        .post_form(
            &don,
            "/calendar/choice",
            &[
                ("event_id", "ambiguous"),
                ("choice", &format!("client:{}", Uuid::new_v4())),
            ],
        )
        .await;
    assert_eq!(res.status(), 400);
    let res = w
        .post_form(
            &don,
            "/calendar/choice",
            &[
                ("event_id", "ambiguous"),
                ("choice", &format!("client:{beta}")),
            ],
        )
        .await;
    assert_eq!(res.status(), 303);
    let res = w
        .post_form(
            &don,
            "/calendar/choice",
            &[("event_id", "unknown"), ("choice", "internal")],
        )
        .await;
    assert_eq!(res.status(), 303);
    // Amy cannot change Don's events.
    let res = w
        .post_form(
            &amy,
            "/calendar/choice",
            &[("event_id", "acme"), ("choice", "skip")],
        )
        .await;
    assert_eq!(res.status(), 404);
    let atts = w.attendances().await;
    assert_eq!(atts.len(), 4);
    assert!(atts.iter().any(|a| a.3 == Some(beta)));
    assert!(atts.iter().any(|a| a.2 == "internal" && a.3.is_none()));

    // Reschedule: same attendance, new version and time.
    let acme_id: Uuid =
        sqlx::query_scalar("SELECT id FROM calendar_attendances WHERE meet_code = 'abc-defg-hij'")
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    let t2 = t + Duration::minutes(45);
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event("acme", t2, 30, "abc-defg-hij", &["ceo@acme.test"]);
        e["updated"] = json!((Utc::now() + Duration::seconds(5)).to_rfc3339());
        g.add("don@calari.test", e.clone());
    }
    w.sync(now).await;
    {
        // A stale update (older `updated`) arriving later is ignored.
        let mut g = w.google.lock().unwrap();
        let mut stale = event("acme", t, 30, "abc-defg-hij", &["ceo@acme.test"]);
        stale["updated"] = json!((Utc::now() - Duration::hours(1)).to_rfc3339());
        g.add("don@calari.test", stale);
    }
    w.sync(now).await;
    // Amy still has the meeting at the old time: her attendance stays, and
    // Don's moved copy gets its own at the new time (one bot per meeting and
    // start time).
    let don_linked = |w: &World| {
        let db = w.state.db.clone();
        async move {
            sqlx::query_as::<_, (Uuid, String, i32, chrono::DateTime<Utc>)>(
                "SELECT a.id, a.state, a.version, a.starts_at FROM calendar_events e JOIN calendar_connections c ON c.id = e.connection_id
                 JOIN calendar_attendances a ON a.id = e.attendance_id WHERE c.calari_user_id = $1 AND e.event_id = 'acme'",
            )
            .bind(DON)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let (moved_id, st, _, starts) = don_linked(&w).await;
    assert_eq!(st, "scheduled");
    assert_eq!(starts.timestamp(), t2.timestamp(), "stale update ignored");
    assert_ne!(moved_id, acme_id);
    let (st, starts): (String, chrono::DateTime<Utc>) =
        sqlx::query_as("SELECT state, starts_at FROM calendar_attendances WHERE id = $1")
            .bind(acme_id)
            .fetch_one(&w.state.db)
            .await
            .unwrap();
    assert_eq!(
        (st.as_str(), starts.timestamp()),
        ("scheduled", t.timestamp())
    );

    // Moving a meeting only Don has reschedules it in place.
    let (tz_id, tz_ver): (Uuid, i32) = sqlx::query_as(
        "SELECT id, version FROM calendar_attendances WHERE meet_code = 'tzz-tzzz-tzz'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event(
            "tz",
            t + Duration::hours(1) + Duration::minutes(15),
            60,
            "tzz-tzzz-tzz",
            &["ceo@acme.test"],
        );
        e["updated"] = json!((Utc::now() + Duration::seconds(6)).to_rfc3339());
        g.add("don@calari.test", e);
    }
    w.sync(now).await;
    let (id2, ver2, st2): (Uuid, i32, String) = sqlx::query_as("SELECT id, version, state FROM calendar_attendances WHERE meet_code = 'tzz-tzzz-tzz' AND state <> 'cancelled'").fetch_one(&w.state.db).await.unwrap();
    assert_eq!((id2, ver2, st2.as_str()), (tz_id, tz_ver + 1, "scheduled"));

    // Don deletes the event: his attendance is cancelled; Amy's is untouched.
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event("acme", t2, 30, "abc-defg-hij", &["ceo@acme.test"]);
        e["status"] = json!("cancelled");
        e["updated"] = json!((Utc::now() + Duration::seconds(10)).to_rfc3339());
        g.add("don@calari.test", e);
    }
    w.sync(now).await;
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(moved_id)
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "cancelled");
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(acme_id)
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "scheduled");

    // Amy declines too: the shared attendance is now cancelled.
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event("amy-copy", t, 30, "abc-defg-hij", &["ceo@acme.test"]);
        e["attendees"][0]["responseStatus"] = json!("declined");
        e["updated"] = json!((Utc::now() + Duration::seconds(10)).to_rfc3339());
        g.add("amy@calari.test", e);
    }
    w.sync(now).await;
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(acme_id)
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "cancelled");

    // Declining cancels too.
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event(
            "tz",
            t + Duration::hours(1) + Duration::minutes(15),
            60,
            "tzz-tzzz-tzz",
            &["ceo@acme.test"],
        );
        e["attendees"][0]["responseStatus"] = json!("declined");
        e["updated"] = json!((Utc::now() + Duration::seconds(10)).to_rfc3339());
        g.add("don@calari.test", e);
    }
    w.sync(now).await;
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(tz_id)
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "cancelled");

    // An event that vanished while we were away (absent from a complete
    // window listing) is treated as deleted.
    {
        let mut g = w.google.lock().unwrap();
        let cal = g.cals.get_mut("don@calari.test").unwrap();
        cal.log.retain(|(_, e)| e["id"] != "unknown");
    }
    w.sync(now).await;
    let (st, ev): (String, String) = sqlx::query_as("SELECT a.state, e.status FROM calendar_events e LEFT JOIN calendar_attendances a ON a.meet_code = e.meet_code WHERE e.event_id = 'unknown'").fetch_one(&w.state.db).await.unwrap();
    assert_eq!((st.as_str(), ev.as_str()), ("cancelled", "cancelled"));

    // Pause: everything Don owns that has not started is cancelled.
    let res = w
        .post_form(&don, "/calendar/settings", &[("auto_join", "off")])
        .await;
    assert_eq!(res.status(), 303);
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_attendances a JOIN calendar_connections c ON c.id = a.owner_connection_id WHERE c.calari_user_id = $1 AND a.state = 'scheduled'").bind(DON).fetch_one(&w.state.db).await.unwrap();
    assert_eq!(live, 0);
    w.drop_db().await;
}

#[tokio::test]
async fn scheduled_meeting_is_prepared_claimed_recorded_and_delivered() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    w.connect(&don, "don@calari.test").await;
    let now = Utc::now();
    {
        let mut g = w.google.lock().unwrap();
        g.add(
            "don@calari.test",
            event(
                "soon",
                now + Duration::seconds(60),
                30,
                "abc-defg-hij",
                &["ceo@acme.test"],
            ),
        );
        g.add(
            "don@calari.test",
            event(
                "soon2",
                now + Duration::seconds(90),
                30,
                "xyz-wxyz-xyz",
                &["ceo@acme.test"],
            ),
        );
    }
    w.sync(now).await;
    // Bot API needs the runner token.
    let res = w
        .http
        .post(format!("{}/v1/calendar-bot/claim", w.cap))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let res = w
        .http
        .post(format!("{}/v1/calendar-bot/claim", w.cap))
        .header("authorization", "Bearer wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    // Nothing is ready before preparation.
    assert_eq!(w.bot("POST", "/v1/calendar-bot/claim", None).await.0, 204);

    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    {
        let c = w.calari.lock().unwrap();
        assert_eq!(c.pairing_requests.len(), 2);
        let r = &c.pairing_requests[0];
        assert_eq!(r.user_id, DON);
        assert_eq!(r.client_id.as_deref(), Some(acme.to_string().as_str()));
        assert_eq!(c.bad_signatures, 0);
    }
    let ready: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_attendances WHERE state = 'ready' AND device_token_ciphertext IS NOT NULL").fetch_one(&w.state.db).await.unwrap();
    assert_eq!(ready, 2);
    // The bot device cannot be minted through the public redeem endpoint.
    let res = w
        .http
        .post(format!("{}/v1/pairings/redeem", w.cap))
        .json(&json!({"code": "AAAA-AAAA", "device_name": "x", "device_kind": "calendar_bot"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);

    let (s, job) = w.bot("POST", "/v1/calendar-bot/claim", None).await;
    assert_eq!(s, 200, "{job}");
    assert_eq!(job["meet_code"], "abc-defg-hij");
    assert_eq!(job["display_name"], "Calari Notetaker");
    let token = job["device_token"].as_str().unwrap().to_owned();
    let att = job["attendance_id"].as_str().unwrap().to_owned();
    let lease = job["lease_token"].as_str().unwrap().to_owned();
    // Cap of one concurrent attendance.
    assert_eq!(w.bot("POST", "/v1/calendar-bot/claim", None).await.0, 204);

    let report = |state: &str, meeting: Option<&str>, lease: &str| {
        let mut v = json!({"lease_token": lease, "state": state});
        if let Some(m) = meeting {
            v["meeting_id"] = json!(m);
        }
        v
    };
    let path = format!("/v1/calendar-bot/attendances/{att}/report");
    // Fencing: a wrong lease token is refused.
    assert_eq!(
        w.bot(
            "POST",
            &path,
            Some(report("joining", None, &Uuid::new_v4().to_string()))
        )
        .await
        .0,
        409
    );
    let (s, a) = w
        .bot("POST", &path, Some(report("joining", None, &lease)))
        .await;
    assert_eq!((s, a["continue"].as_bool()), (200, Some(true)));
    assert_eq!(
        w.bot("POST", &path, Some(report("waiting", None, &lease)))
            .await
            .0,
        200
    );

    // The bot records through the normal device API.
    let m: Value = w.http.post(format!("{}/v1/meetings", w.cap)).bearer_auth(&token)
        .json(&json!({"title": "Meeting soon", "idempotency_key": "bot-1", "started_at": Utc::now(), "capture_mode": "audio"}))
        .send().await.unwrap().json().await.unwrap();
    let mid = m["id"].as_str().unwrap().to_owned();
    // A meeting from some other device is refused.
    assert_eq!(
        w.bot(
            "POST",
            &path,
            Some(report(
                "recording",
                Some(&Uuid::new_v4().to_string()),
                &lease
            ))
        )
        .await
        .0,
        409
    );
    assert_eq!(
        w.bot("POST", &path, Some(report("recording", Some(&mid), &lease)))
            .await
            .0,
        200
    );
    // Going backwards is refused.
    assert_eq!(
        w.bot("POST", &path, Some(report("joining", None, &lease)))
            .await
            .0,
        409
    );
    for seq in 0..2u32 {
        let mut bytes = b"OggS\0\x02".to_vec();
        bytes.extend(std::iter::repeat_n(seq as u8, 64));
        let res = w
            .http
            .put(format!("{}/v1/meetings/{mid}/chunks/{seq}", w.cap))
            .bearer_auth(&token)
            .header(
                "x-chunk-sha256",
                cap_meeting_protocol::ids::sha256_hex(&bytes),
            )
            .header("x-chunk-start-ms", (seq as u64 * 1000).to_string())
            .header("x-chunk-duration-ms", "1000")
            .body(bytes)
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{:?}", res.text().await);
    }
    let res = w.http.post(format!("{}/v1/meetings/{mid}/finalize", w.cap)).bearer_auth(&token)
        .json(&json!({"last_seq": 1, "stop_reason": "meeting_ended", "ended_at": Utc::now() + Duration::seconds(2)}))
        .send().await.unwrap();
    assert!(res.status().is_success(), "{:?}", res.text().await);
    let (s, a) = w
        .bot("POST", &path, Some(report("completed", Some(&mid), &lease)))
        .await;
    assert_eq!((s, a["continue"].as_bool()), (200, Some(false)));
    // After completion the old lease is dead.
    assert_eq!(
        w.bot("POST", &path, Some(report("completed", None, &lease)))
            .await
            .0,
        409
    );

    while worker::run_once(&w.state, Utc::now()).await.unwrap() {}
    {
        let c = w.calari.lock().unwrap();
        assert_eq!(c.bad_signatures, 0);
        assert_eq!(c.deliveries.len(), 1);
        let d = &c.deliveries[0];
        assert_eq!(d["tenant_id"], TENANT);
        assert_eq!(d["client_id"], acme.to_string());
        assert_eq!(d["context"]["pairing_kind"], "staff_client");
        assert_eq!(d["meeting"]["source"], "calendar_bot");
        assert_eq!(d["meeting"]["provider_hint"], "google_meet");
        assert_eq!(
            d["meeting"]["meeting_url"],
            "https://meet.google.com/abc-defg-hij"
        );
        let pairing: String = d["pairing_id"].as_str().unwrap().into();
        assert!(Uuid::parse_str(&pairing).is_ok());
    }
    // Finished: the bot's device no longer works.
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let res = w
        .http
        .get(format!("{}/v1/meetings/{mid}", w.cap))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    // Second meeting: the runner crashes after claiming; the lease expires,
    // it is re-queued, and the dead runner's lease is fenced off.
    let (s, job2) = w.bot("POST", "/v1/calendar-bot/claim", None).await;
    assert_eq!(s, 200);
    let att2 = job2["attendance_id"].as_str().unwrap().to_owned();
    let lease2 = job2["lease_token"].as_str().unwrap().to_owned();
    attendance::schedule::tick(&w.state, Utc::now() + Duration::minutes(3))
        .await
        .unwrap();
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(Uuid::parse_str(&att2).unwrap())
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "ready");
    assert_eq!(
        w.bot(
            "POST",
            &format!("/v1/calendar-bot/attendances/{att2}/report"),
            Some(report("joining", None, &lease2))
        )
        .await
        .0,
        409
    );
    let (s, job3) = w.bot("POST", "/v1/calendar-bot/claim", None).await;
    assert_eq!(s, 200);
    let lease3 = job3["lease_token"].as_str().unwrap().to_owned();
    // Staff skips it while the bot waits: the bot is told to leave.
    let res = w
        .post_form(
            &don,
            "/calendar/choice",
            &[("event_id", "soon2"), ("choice", "skip")],
        )
        .await;
    assert_eq!(res.status(), 303);
    let (s, a) = w
        .bot(
            "POST",
            &format!("/v1/calendar-bot/attendances/{att2}/report"),
            Some(report("waiting", None, &lease3)),
        )
        .await;
    assert_eq!((s, a["continue"].as_bool()), (200, Some(false)));
    let (s, _) = w
        .bot(
            "POST",
            &format!("/v1/calendar-bot/attendances/{att2}/report"),
            Some(report("completed", None, &lease3)),
        )
        .await;
    assert_eq!(s, 200);
    let st: String = sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1")
        .bind(Uuid::parse_str(&att2).unwrap())
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(st, "cancelled");
    w.drop_db().await;
}

#[tokio::test]
async fn revocation_refusal_and_crash_recovery_fail_closed() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    let amy = w.sign_in(AMY).await;
    w.connect(&don, "don@calari.test").await;
    w.connect(&amy, "amy@calari.test").await;
    let now = Utc::now();
    {
        let mut g = w.google.lock().unwrap();
        g.add(
            "don@calari.test",
            event(
                "d1",
                now + Duration::seconds(100),
                30,
                "ddd-dddd-ddd",
                &["ceo@acme.test"],
            ),
        );
        g.add(
            "amy@calari.test",
            event(
                "a1",
                now + Duration::hours(5),
                30,
                "aaa-aaaa-aaa",
                &["ceo@acme.test"],
            ),
        );
        g.add(
            "amy@calari.test",
            event(
                "a2",
                now + Duration::seconds(100),
                30,
                "bbb-bbbb-bbb",
                &["ceo@acme.test"],
            ),
        );
    }
    w.sync(now).await;
    assert_eq!(w.attendances().await.len(), 3);

    // Crash during preparation: the lease expires and it is re-queued.
    sqlx::query("UPDATE calendar_attendances SET state = 'preparing', lease_token = gen_random_uuid(), lease_until = now() - interval '1 second' WHERE meet_code = 'ddd-dddd-ddd'")
        .execute(&w.state.db).await.unwrap();
    attendance::schedule::expire(&w.state, Utc::now())
        .await
        .unwrap();
    let st: String = sqlx::query_scalar(
        "SELECT state FROM calendar_attendances WHERE meet_code = 'ddd-dddd-ddd'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(st, "scheduled");

    // Calari refuses the pairing (e.g. client access removed): needs review, no device.
    w.calari.lock().unwrap().refuse_pairing = true;
    attendance::schedule::tick(&w.state, Utc::now())
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<Vec<u8>>)> = sqlx::query_as("SELECT meet_code, state, device_token_ciphertext FROM calendar_attendances WHERE meet_code IN ('ddd-dddd-ddd', 'bbb-bbbb-bbb')").fetch_all(&w.state.db).await.unwrap();
    assert!(
        rows.iter().all(|r| r.1 == "needs_review" && r.2.is_none()),
        "{rows:?}"
    );
    w.calari.lock().unwrap().refuse_pairing = false;

    // Google refresh token revoked outside Cap: needs reconnecting, future
    // attendance cancelled, credential deleted.
    {
        let mut g = w.google.lock().unwrap();
        let rts: Vec<String> = g
            .refresh
            .iter()
            .filter(|(_, e)| *e == "don@calari.test")
            .map(|(k, _)| k.clone())
            .collect();
        g.revoked.extend(rts);
    }
    w.sync(now).await;
    let (status, ct): (String, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT status, refresh_ciphertext FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(DON)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(status, "needs_reconnect");
    assert!(ct.is_none());
    let st: String = sqlx::query_scalar(
        "SELECT state FROM calendar_attendances WHERE meet_code = 'ddd-dddd-ddd'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(st, "cancelled");
    let page = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &don.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Needs reconnecting"));
    // Reconnecting works and starts a fresh window.
    w.connect(&don, "don@calari.test").await;
    let (status, sync): (String, Option<String>) = sqlx::query_as(
        "SELECT status, sync_run_token FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(DON)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!((status.as_str(), sync), ("active", None));

    // Staff deactivated in Calari: the next sync revokes the connection at
    // Google, deletes the credential and cancels her attendance.
    w.calari.lock().unwrap().users.get_mut(AMY).unwrap().1 = false;
    let before = w.google.lock().unwrap().revoke_calls.len();
    w.sync(now).await;
    let (status, ct): (String, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT status, refresh_ciphertext FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(AMY)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(status, "revoked");
    assert!(ct.is_none());
    assert_eq!(w.google.lock().unwrap().revoke_calls.len(), before + 1);
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_attendances WHERE meet_code IN ('aaa-aaaa-aaa', 'bbb-bbbb-bbb') AND state NOT IN ('cancelled')").fetch_one(&w.state.db).await.unwrap();
    assert_eq!(live, 0);
    // Her web session is refused too (Calari says inactive).
    let res = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &amy.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["location"], "/login");

    // Disconnect: revoked at Google, credential gone, attendance cancelled.
    let n = w.google.lock().unwrap().revoke_calls.len();
    let res = w.post_form(&don, "/calendar/disconnect", &[]).await;
    assert_eq!(res.status(), 303);
    assert_eq!(w.google.lock().unwrap().revoke_calls.len(), n + 1);
    let (status, ct): (String, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT status, refresh_ciphertext FROM calendar_connections WHERE calari_user_id = $1",
    )
    .bind(DON)
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(status, "revoked");
    assert!(ct.is_none());
    // A revoked connection is never synced again.
    let calls = w.google.lock().unwrap().event_requests.len();
    w.sync(now).await;
    assert_eq!(w.google.lock().unwrap().event_requests.len(), calls);
    w.drop_db().await;
}

#[tokio::test]
async fn concurrent_reconcile_creates_one_attendance() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    let amy = w.sign_in(AMY).await;
    w.connect(&don, "don@calari.test").await;
    w.connect(&amy, "amy@calari.test").await;
    let t = Utc::now() + Duration::hours(2);
    {
        let mut g = w.google.lock().unwrap();
        g.add(
            "don@calari.test",
            event("x", t, 30, "same-code-xx", &["ceo@acme.test"]),
        );
        g.add(
            "amy@calari.test",
            event("y", t, 30, "abc-defg-hij", &["ceo@acme.test"]),
        );
        g.add(
            "don@calari.test",
            event("z", t, 30, "abc-defg-hij", &["ceo@acme.test"]),
        );
    }
    w.sync(Utc::now()).await;
    // Re-run both reconciliations concurrently many times.
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM calendar_connections")
        .fetch_all(&w.state.db)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..10 {
        for id in &ids {
            let s = w.state.clone();
            let id = *id;
            tasks.push(tokio::spawn(async move {
                attendance::schedule::reconcile_connection(&s, id, Utc::now())
                    .await
                    .unwrap()
            }));
        }
    }
    for t in tasks {
        t.await.unwrap();
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM calendar_attendances WHERE meet_code = 'abc-defg-hij'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(n, 1);
    // "same-code-xx" is not a valid Meet code: no attendance at all.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM calendar_attendances WHERE meet_code = 'same-code-xx'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert_eq!(n, 0);
    w.drop_db().await;
}

#[tokio::test]
async fn endless_recurring_series_stays_bounded_and_rolls_in() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    w.connect(&don, "don@calari.test").await;
    let now = Utc::now();
    let base = now + Duration::hours(2);
    {
        // A daily series with no end (Google expands instances; the window
        // bounds them), plus one ordinary meeting.
        let mut g = w.google.lock().unwrap();
        for day in 0..400 {
            let mut e = event(
                &format!("daily_{day}"),
                base + Duration::days(day),
                15,
                "day-dail-yyy",
                &["ceo@acme.test"],
            );
            e["recurringEventId"] = json!("daily");
            g.add("don@calari.test", e);
        }
        g.add(
            "don@calari.test",
            event(
                "one-off",
                now + Duration::hours(3),
                30,
                "one-offf-one",
                &["ceo@acme.test"],
            ),
        );
    }
    w.sync(now).await;
    let requests = w.google.lock().unwrap().event_requests.len();
    assert!(
        requests <= 10,
        "finite listing, not 400 instances: {requests} requests"
    );
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM calendar_attendances WHERE meet_code = 'day-dail-yyy'",
    )
    .fetch_one(&w.state.db)
    .await
    .unwrap();
    assert!(
        (14..=15).contains(&n),
        "only instances inside the 14-day window: {n}"
    );
    let one: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_attendances WHERE meet_code = 'one-offf-one' AND state = 'scheduled'")
        .fetch_one(&w.state.db).await.unwrap();
    assert_eq!(one, 1, "the upcoming meeting is scheduled in the same pass");
    let far = base + Duration::days(20);
    let has_far = |w: &World| {
        let db = w.state.db.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM calendar_attendances WHERE starts_at = $1",
            )
            .bind(far)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(has_far(&w).await, 0);
    // A week later the window has moved: day 20 enters without any edit.
    w.sync(now + Duration::days(7)).await;
    assert_eq!(has_far(&w).await, 1);
    w.drop_db().await;
}

#[tokio::test]
async fn calendar_is_admin_only_unless_widened() {
    let Some(w) = World::with_staff_access(TranscriptionConfig::TestFixture, false).await else {
        return;
    };
    w.staff(DON, "don@calari.test");
    let don = w.sign_in(DON).await; // the stand-in signs everyone in as "staff"
    let res = w
        .http
        .get(format!("{}/calendar", w.cap))
        .header("cookie", &don.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let res = w.post_form(&don, "/calendar/connect", &[]).await;
    assert_eq!(res.status(), 403);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_oauth_attempts")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    w.drop_db().await;
}

#[tokio::test]
async fn unanswered_invites_never_bring_the_bot_and_disconnect_forgets_events() {
    let Some(w) = world().await else { return };
    let acme = Uuid::new_v4();
    w.client("ceo@acme.test", acme, "Acme Ltd");
    let don = w.sign_in(DON).await;
    w.connect(&don, "don@calari.test").await;
    let t = Utc::now() + Duration::hours(2);
    {
        let mut g = w.google.lock().unwrap();
        // An outsider's invite Google added automatically, naming a mapped client.
        let mut e = event("unsolicited", t, 30, "abc-defg-hij", &["ceo@acme.test"]);
        e["attendees"][0]["responseStatus"] = json!("needsAction");
        g.add("don@calari.test", e);
        let mut e = event("maybe", t, 30, "may-mayb-may", &["ceo@acme.test"]);
        e["attendees"][0]["responseStatus"] = json!("tentative");
        g.add("don@calari.test", e);
        // Not a Meet meeting: nothing about it is kept.
        let mut lunch = event("lunch", t, 60, "x", &["friend@else.test"]);
        lunch.as_object_mut().unwrap().remove("hangoutLink");
        g.add("don@calari.test", lunch);
    }
    w.sync(Utc::now()).await;
    assert!(w.attendances().await.is_empty());
    let stored: Vec<String> =
        sqlx::query_scalar("SELECT event_id FROM calendar_events ORDER BY event_id")
            .fetch_all(&w.state.db)
            .await
            .unwrap();
    assert_eq!(stored, vec!["maybe".to_owned(), "unsolicited".to_owned()]);
    // Accepting it schedules it.
    {
        let mut g = w.google.lock().unwrap();
        let mut e = event("unsolicited", t, 30, "abc-defg-hij", &["ceo@acme.test"]);
        e["updated"] = json!((Utc::now() + Duration::seconds(5)).to_rfc3339());
        g.add("don@calari.test", e);
    }
    w.sync(Utc::now()).await;
    assert_eq!(w.attendances().await.len(), 1);
    // Disconnect removes every stored event.
    assert_eq!(
        w.post_form(&don, "/calendar/disconnect", &[])
            .await
            .status(),
        303
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM calendar_events")
        .fetch_one(&w.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    w.drop_db().await;
}
