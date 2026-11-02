//! Durable attendance schedule.
//!
//! - Reconciliation turns synced events into attendances under a per-meeting
//!   advisory lock: one bot per tenant + Meet code + start time, however many
//!   connected calendars contain the meeting. Edits reschedule, deletions and
//!   declines cancel.
//! - Preparation (shortly before the start) asks Calari for a pairing as the
//!   owning staff member and redeems it internally into a one-meeting bot
//!   device whose token is stored encrypted for the bot runner.
//! - Leases with fencing tokens guard every step; a runner that stops
//!   reporting loses its claim and its meeting is finalized with the audio
//!   that arrived.

use super::{calari, crypto, PURPOSE_DEVICE};
use crate::{
    calendar::{self, ClientMatch, Decision},
    AppState,
};
use anyhow::{Context, Result};
use cap_meeting_protocol::{ids, CalendarPairingRequest};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// States in which an attendance can still change without disturbing a bot.
pub const NOT_STARTED: &[&str] = &["scheduled", "preparing", "ready", "needs_review"];
/// A bot holds the attendance.
pub const IN_PROGRESS: &[&str] = &["claimed", "joining", "waiting", "recording"];
const PREPARE_MINUTES: i64 = 5;
const MAX_PREPARE_ATTEMPTS: i32 = 6;
const MAX_CLAIMS: i32 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Routing {
    Client(Uuid),
    Internal,
}

impl Routing {
    fn kind(&self) -> &'static str {
        match self {
            Routing::Client(_) => "client",
            Routing::Internal => "internal",
        }
    }
    fn client(&self) -> Option<Uuid> {
        match self {
            Routing::Client(id) => Some(*id),
            Routing::Internal => None,
        }
    }
}

#[derive(Deserialize)]
struct Candidate {
    email: String,
    client_id: String,
}

/// The staff member's choice wins; otherwise only an unambiguous verified
/// attendee mapping selects a client. Titles never route.
pub fn routing_for(
    choice: &str,
    choice_client: Option<Uuid>,
    candidates: &serde_json::Value,
    attendees: &[String],
) -> Option<Routing> {
    match choice {
        "internal" => Some(Routing::Internal),
        "client" => choice_client.map(Routing::Client),
        "skip" => None,
        _ => {
            let mappings: Vec<(String, Uuid)> =
                serde_json::from_value::<Vec<Candidate>>(candidates.clone())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|c| ids::parse_uuid(&c.client_id).map(|id| (c.email, id)))
                    .collect();
            match calendar::match_client(None, attendees, &mappings) {
                ClientMatch::Matched(id) => Some(Routing::Client(id)),
                ClientMatch::NeedsReview => None,
            }
        }
    }
}

/// Outcome for one event; `NeedsReview` means "ask the staff member".
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Cancel,
    NeedsReview,
    Schedule { routing: Routing, meet_code: String },
}

pub struct EventFacts<'a> {
    pub connected: bool,
    pub auto_join: bool,
    pub status: &'a str,
    pub self_declined: bool,
    pub self_accepted: bool,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub meet_code: Option<&'a str>,
    pub choice: &'a str,
    pub routing: Option<Routing>,
}

pub fn plan(e: EventFacts<'_>, now: DateTime<Utc>) -> Plan {
    let (Some(starts_at), Some(ends_at), Some(code)) = (e.starts_at, e.ends_at, e.meet_code) else {
        return Plan::Cancel;
    };
    let url = format!("https://meet.google.com/{code}");
    // The routing slot is only a placeholder for `decide`; the real routing
    // (including "internal") is carried separately.
    let client = if e.routing.is_some() {
        ClientMatch::Matched(Uuid::nil())
    } else {
        ClientMatch::NeedsReview
    };
    let decision = calendar::decide(
        calendar::Event {
            connected: e.connected,
            enabled: e.auto_join && e.choice != "skip",
            deleted: e.status == "cancelled",
            declined: e.self_declined || !e.self_accepted,
            starts_at,
            ends_at,
            meeting_url: &url,
            client,
        },
        now,
    );
    match (decision, e.routing) {
        (Decision::Cancel, _) => Plan::Cancel,
        (Decision::NeedsClient, _) | (Decision::Schedule { .. }, None) => Plan::NeedsReview,
        (Decision::Schedule { meeting_code, .. }, Some(routing)) => Plan::Schedule {
            routing,
            meet_code: meeting_code,
        },
    }
}

async fn log(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    kind: &str,
    detail: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO calendar_attendance_log (attendance_id, kind, detail) VALUES ($1, $2, $3)",
    )
    .bind(id)
    .bind(kind)
    .bind(detail.map(|d| d.chars().take(300).collect::<String>()))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Recomputes every relevant event of one connection.
pub async fn reconcile_connection(
    state: &AppState,
    connection_id: Uuid,
    now: DateTime<Utc>,
) -> Result<()> {
    let horizon = state
        .cfg
        .calendar
        .as_ref()
        .and_then(|c| Duration::from_std(c.horizon).ok())
        .unwrap_or(Duration::days(14));
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT event_id FROM calendar_events WHERE connection_id = $1
           AND (attendance_id IS NOT NULL OR (meet_code IS NOT NULL AND ends_at > $2 AND starts_at < $3))",
    )
    .bind(connection_id)
    .bind(now)
    .bind(now + horizon)
    .fetch_all(&state.db)
    .await?;
    for event_id in events {
        reconcile_event(state, connection_id, &event_id, now).await?;
    }
    Ok(())
}

pub async fn reconcile_event(
    state: &AppState,
    connection_id: Uuid,
    event_id: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let conn = sqlx::query(
        "SELECT tenant_id, status, auto_join FROM calendar_connections WHERE id = $1 FOR SHARE",
    )
    .bind(connection_id)
    .fetch_one(&mut *tx)
    .await?;
    let tenant: String = conn.get("tenant_id");
    let e = sqlx::query(
        "SELECT status, title, starts_at, ends_at, meet_code, attendee_emails, self_declined, self_accepted, choice,
                choice_client_id, candidates, attendance_id
         FROM calendar_events WHERE connection_id = $1 AND event_id = $2",
    )
    .bind(connection_id)
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(e) = e else { return Ok(()) };
    let meet_code: Option<String> = e.get("meet_code");
    // Serialize per meeting so two calendars never create two bots.
    let lock_key = format!("{tenant}|{}", meet_code.as_deref().unwrap_or(event_id));
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7))")
        .bind(&lock_key)
        .execute(&mut *tx)
        .await?;
    let attendees: Vec<String> =
        serde_json::from_value(e.get("attendee_emails")).unwrap_or_default();
    let choice: String = e.get("choice");
    let routing = routing_for(
        &choice,
        e.get("choice_client_id"),
        &e.get("candidates"),
        &attendees,
    );
    let linked: Option<Uuid> = e.get("attendance_id");
    // A meeting that has started is not cancelled merely because time
    // passed; only real changes (deleted, declined, skipped) affect it.
    let starts_opt: Option<DateTime<Utc>> = e.get("starts_at");
    let eval_now = match (linked, starts_opt) {
        (Some(_), Some(s)) if s <= now => s - Duration::seconds(1),
        _ => now,
    };
    let p = plan(
        EventFacts {
            connected: conn.get::<String, _>("status") == "active",
            auto_join: conn.get("auto_join"),
            status: &e.get::<String, _>("status"),
            self_declined: e.get("self_declined"),
            self_accepted: e.get("self_accepted"),
            starts_at: e.get("starts_at"),
            ends_at: e.get("ends_at"),
            meet_code: meet_code.as_deref(),
            choice: &choice,
            routing,
        },
        eval_now,
    );
    let title: String = e.get("title");
    match p {
        Plan::Cancel | Plan::NeedsReview => {
            if let Some(a) = linked {
                detach(
                    &mut tx,
                    connection_id,
                    event_id,
                    a,
                    "event cancelled, declined or needs review",
                )
                .await?;
            }
        }
        Plan::Schedule { routing, meet_code } => {
            let starts: DateTime<Utc> = e
                .get::<Option<DateTime<Utc>>, _>("starts_at")
                .context("start")?;
            let ends: DateTime<Utc> = e
                .get::<Option<DateTime<Utc>>, _>("ends_at")
                .context("end")?;
            let mut current = linked;
            if let Some(a) = linked {
                let row = sqlx::query("SELECT state, owner_connection_id, meet_code, starts_at, ends_at, routing, client_id FROM calendar_attendances WHERE id = $1 FOR UPDATE")
                    .bind(a)
                    .fetch_one(&mut *tx)
                    .await?;
                let st: String = row.get("state");
                if !NOT_STARTED.contains(&st.as_str()) && !IN_PROGRESS.contains(&st.as_str()) {
                    // Finished or cancelled earlier: a restored event gets a fresh attendance.
                    sqlx::query("UPDATE calendar_events SET attendance_id = NULL WHERE connection_id = $1 AND event_id = $2")
                        .bind(connection_id)
                        .bind(event_id)
                        .execute(&mut *tx)
                        .await?;
                    current = None;
                } else {
                    let owner = row.get::<Uuid, _>("owner_connection_id") == connection_id;
                    let moved = row.get::<String, _>("meet_code") != meet_code
                        || row.get::<DateTime<Utc>, _>("starts_at") != starts;
                    let details = row.get::<DateTime<Utc>, _>("ends_at") != ends
                        || row.get::<String, _>("routing") != routing.kind()
                        || row.get::<Option<Uuid>, _>("client_id") != routing.client();
                    let others: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM calendar_events WHERE attendance_id = $1 AND NOT (connection_id = $2 AND event_id = $3)",
                    )
                    .bind(a)
                    .bind(connection_id)
                    .bind(event_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if IN_PROGRESS.contains(&st.as_str()) {
                        if moved || (owner && details) {
                            log(&mut tx, a, "change_ignored_in_progress", None).await?;
                        }
                    } else if moved && (!owner || others > 0) {
                        // This calendar's copy moved; the others keep theirs.
                        detach(&mut tx, connection_id, event_id, a, "event moved").await?;
                        current = None;
                    } else if owner && (moved || details) {
                        // Reschedule in place: a new version needs a new pairing.
                        revoke_device(&mut tx, a).await?;
                        sqlx::query(
                            "UPDATE calendar_attendances SET meet_code = $2, starts_at = $3, ends_at = $4, routing = $5,
                                    client_id = $6, title = $7, state = 'scheduled', version = version + 1, attempts = 0,
                                    next_attempt_at = now(), pairing_id = NULL, lease_token = NULL, lease_until = NULL,
                                    failure = NULL, updated_at = now() WHERE id = $1",
                        )
                        .bind(a)
                        .bind(&meet_code)
                        .bind(starts)
                        .bind(ends)
                        .bind(routing.kind())
                        .bind(routing.client())
                        .bind(&title)
                        .execute(&mut *tx)
                        .await?;
                        log(&mut tx, a, "rescheduled", None).await?;
                    }
                }
            }
            if current.is_none() && starts > now {
                let existing: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM calendar_attendances WHERE tenant_id = $1 AND meet_code = $2 AND starts_at = $3
                       AND state NOT IN ('cancelled', 'failed', 'completed')",
                )
                .bind(&tenant)
                .bind(&meet_code)
                .bind(starts)
                .fetch_optional(&mut *tx)
                .await?;
                let id = match existing {
                    Some(id) => {
                        log(
                            &mut tx,
                            id,
                            "deduplicated",
                            Some("another connected calendar has this meeting"),
                        )
                        .await?;
                        id
                    }
                    None => {
                        let id = Uuid::new_v4();
                        sqlx::query(
                            "INSERT INTO calendar_attendances (id, tenant_id, owner_connection_id, meet_code, starts_at, ends_at, title, routing, client_id, state)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')",
                        )
                        .bind(id)
                        .bind(&tenant)
                        .bind(connection_id)
                        .bind(&meet_code)
                        .bind(starts)
                        .bind(ends)
                        .bind(&title)
                        .bind(routing.kind())
                        .bind(routing.client())
                        .execute(&mut *tx)
                        .await?;
                        log(&mut tx, id, "scheduled", None).await?;
                        id
                    }
                };
                sqlx::query("UPDATE calendar_events SET attendance_id = $3 WHERE connection_id = $1 AND event_id = $2")
                    .bind(connection_id)
                    .bind(event_id)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Unlinks one event. The attendance moves to another linked calendar when
/// one still wants it, otherwise it is cancelled.
async fn detach(
    tx: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    event_id: &str,
    attendance: Uuid,
    why: &str,
) -> Result<()> {
    sqlx::query("UPDATE calendar_events SET attendance_id = NULL WHERE connection_id = $1 AND event_id = $2")
        .bind(connection_id)
        .bind(event_id)
        .execute(&mut **tx)
        .await?;
    let row = sqlx::query(
        "SELECT state, owner_connection_id FROM calendar_attendances WHERE id = $1 FOR UPDATE",
    )
    .bind(attendance)
    .fetch_one(&mut **tx)
    .await?;
    let st: String = row.get("state");
    let remaining: Option<Uuid> = sqlx::query_scalar(
        "SELECT e.connection_id FROM calendar_events e JOIN calendar_connections c ON c.id = e.connection_id
         WHERE e.attendance_id = $1 AND c.status = 'active' LIMIT 1",
    )
    .bind(attendance)
    .fetch_optional(&mut **tx)
    .await?;
    match remaining {
        Some(next_owner) => {
            if row.get::<Uuid, _>("owner_connection_id") == connection_id
                && NOT_STARTED.contains(&st.as_str())
            {
                revoke_device(tx, attendance).await?;
                sqlx::query(
                    "UPDATE calendar_attendances SET owner_connection_id = $2, state = 'scheduled', version = version + 1,
                            pairing_id = NULL, attempts = 0, next_attempt_at = now(), updated_at = now() WHERE id = $1",
                )
                .bind(attendance)
                .bind(next_owner)
                .execute(&mut **tx)
                .await?;
                log(tx, attendance, "owner_changed", None).await?;
            }
        }
        None => cancel(tx, attendance, why).await?,
    }
    Ok(())
}

/// Cancels one attendance. A bot that holds it learns on its next report and
/// leaves; what it recorded is still finalized and delivered.
pub async fn cancel(tx: &mut Transaction<'_, Postgres>, attendance: Uuid, why: &str) -> Result<()> {
    let st: Option<String> =
        sqlx::query_scalar("SELECT state FROM calendar_attendances WHERE id = $1 FOR UPDATE")
            .bind(attendance)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(st) = st else { return Ok(()) };
    if NOT_STARTED.contains(&st.as_str()) {
        revoke_device(tx, attendance).await?;
    } else if !IN_PROGRESS.contains(&st.as_str()) {
        return Ok(());
    }
    sqlx::query("UPDATE calendar_attendances SET state = 'cancelled', failure = $2, updated_at = now() WHERE id = $1")
        .bind(attendance)
        .bind(why)
        .execute(&mut **tx)
        .await?;
    log(tx, attendance, "cancelled", Some(why)).await?;
    Ok(())
}

pub async fn cancel_for_connection(
    tx: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    why: &str,
) -> Result<()> {
    let linked: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT event_id, attendance_id FROM calendar_events WHERE connection_id = $1 AND attendance_id IS NOT NULL",
    )
    .bind(connection_id)
    .fetch_all(&mut **tx)
    .await?;
    for (event_id, attendance) in linked {
        detach(tx, connection_id, &event_id, attendance, why).await?;
    }
    // Attendances it owns but no event links any more (defensive).
    let owned: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM calendar_attendances WHERE owner_connection_id = $1
           AND state IN ('scheduled', 'preparing', 'ready', 'needs_review')",
    )
    .bind(connection_id)
    .fetch_all(&mut **tx)
    .await?;
    for a in owned {
        cancel(tx, a, why).await?;
    }
    Ok(())
}

async fn revoke_device(tx: &mut Transaction<'_, Postgres>, attendance: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE meeting_devices SET revoked_at = now() WHERE revoked_at IS NULL AND token_hash =
           (SELECT device_token_hash FROM calendar_attendances WHERE id = $1)",
    )
    .bind(attendance)
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE calendar_attendances SET device_token_ciphertext = NULL WHERE id = $1")
        .bind(attendance)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Stable per attendance version, so a retried pairing request is idempotent
/// at Calari and a rescheduled one is new.
pub fn pairing_request_id(attendance: Uuid, version: i32) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("cap.calendar.pairing:{attendance}:{version}").as_bytes(),
    )
}

pub async fn tick(state: &AppState, now: DateTime<Utc>) -> Result<()> {
    expire(state, now).await?;
    while prepare_one(state, now).await? {}
    // Ended events are kept a day for the settings page, then removed.
    sqlx::query(
        "DELETE FROM calendar_events WHERE ends_at < $1 - interval '1 day' AND (attendance_id IS NULL OR attendance_id IN
           (SELECT id FROM calendar_attendances WHERE state IN ('completed', 'cancelled', 'failed')))",
    )
    .bind(now)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM calendar_oauth_attempts WHERE expires_at < $1")
        .bind(now)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Claims one attendance that should get its pairing now.
pub async fn prepare_one(state: &AppState, now: DateTime<Utc>) -> Result<bool> {
    let Some(cal) = state.cfg.calendar.as_ref() else {
        return Ok(false);
    };
    let lead = Duration::from_std(cal.join_lead).unwrap_or(Duration::minutes(2))
        + Duration::minutes(PREPARE_MINUTES);
    let token = Uuid::new_v4();
    let row = sqlx::query(
        "UPDATE calendar_attendances SET state = 'preparing', lease_token = $3, lease_until = $1 + interval '2 minutes',
                attempts = attempts + 1, updated_at = now()
         WHERE id = (SELECT id FROM calendar_attendances WHERE state = 'scheduled' AND next_attempt_at <= $1
                       AND starts_at - $2 <= $1 ORDER BY starts_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, tenant_id, owner_connection_id, meet_code, starts_at, ends_at, title, routing, client_id, version, attempts",
    )
    .bind(now)
    .bind(lead)
    .bind(token)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(false) };
    let id: Uuid = row.get("id");
    let ends: DateTime<Utc> = row.get("ends_at");
    let result = prepare(state, &row, now).await;
    let mut tx = state.db.begin().await?;
    let held: Option<i32> = sqlx::query_scalar("SELECT 1 FROM calendar_attendances WHERE id = $1 AND lease_token = $2 AND state = 'preparing' FOR UPDATE")
        .bind(id)
        .bind(token)
        .fetch_optional(&mut *tx)
        .await?;
    if held.is_none() {
        // Cancelled or rescheduled meanwhile; undo our device if we made one.
        if let Ok(Prepared::Ready { device_hash, .. }) = &result {
            sqlx::query("UPDATE meeting_devices SET revoked_at = now() WHERE token_hash = $1")
                .bind(device_hash)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        return Ok(true);
    }
    match result {
        Ok(Prepared::Ready {
            pairing_id,
            device_hash,
            sealed,
        }) => {
            sqlx::query(
                "UPDATE calendar_attendances SET state = 'ready', pairing_id = $2, device_token_hash = $3,
                        device_token_ciphertext = $4, lease_token = NULL, lease_until = NULL, attempts = 0,
                        failure = NULL, updated_at = now() WHERE id = $1",
            )
            .bind(id)
            .bind(&pairing_id)
            .bind(&device_hash)
            .bind(&sealed)
            .execute(&mut *tx)
            .await?;
            log(&mut tx, id, "ready", None).await?;
        }
        Ok(Prepared::NeedsReview(why)) => {
            sqlx::query("UPDATE calendar_attendances SET state = 'needs_review', failure = $2, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1")
                .bind(id)
                .bind(&why)
                .execute(&mut *tx)
                .await?;
            log(&mut tx, id, "needs_review", Some(&why)).await?;
        }
        Ok(Prepared::Cancel(why)) => {
            sqlx::query("UPDATE calendar_attendances SET state = 'scheduled', lease_token = NULL, lease_until = NULL WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            cancel(&mut tx, id, &why).await?;
        }
        Err(e) => {
            let attempts: i32 = row.get("attempts");
            let why = format!("{e:#}");
            if attempts >= MAX_PREPARE_ATTEMPTS || ends <= now {
                sqlx::query("UPDATE calendar_attendances SET state = 'failed', failure = $2, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1")
                    .bind(id)
                    .bind(why.chars().take(300).collect::<String>())
                    .execute(&mut *tx)
                    .await?;
                log(&mut tx, id, "failed", Some(&why)).await?;
            } else {
                sqlx::query("UPDATE calendar_attendances SET state = 'scheduled', next_attempt_at = $2, failure = $3, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1")
                    .bind(id)
                    .bind(now + Duration::seconds(15 * i64::from(attempts.max(1))))
                    .bind(why.chars().take(300).collect::<String>())
                    .execute(&mut *tx)
                    .await?;
                log(&mut tx, id, "prepare_retry", Some(&why)).await?;
            }
        }
    }
    tx.commit().await?;
    Ok(true)
}

enum Prepared {
    Ready {
        pairing_id: String,
        device_hash: String,
        sealed: Vec<u8>,
    },
    NeedsReview(String),
    Cancel(String),
}

async fn prepare(
    state: &AppState,
    row: &sqlx::postgres::PgRow,
    now: DateTime<Utc>,
) -> Result<Prepared> {
    let cal = state
        .cfg
        .calendar
        .as_ref()
        .context("calendar not configured")?;
    let id: Uuid = row.get("id");
    let ends: DateTime<Utc> = row.get("ends_at");
    if ends <= now {
        return Ok(Prepared::Cancel(
            "meeting ended before the bot could be prepared".into(),
        ));
    }
    let owner = super::Connection::load(state, row.get("owner_connection_id")).await?;
    if owner.status != "active" {
        return Ok(Prepared::Cancel("calendar connection is not active".into()));
    }
    let tenant: String = row.get("tenant_id");
    let client: Option<Uuid> = row.get("client_id");
    let starts: DateTime<Utc> = row.get("starts_at");
    let req = CalendarPairingRequest {
        request_id: pairing_request_id(id, row.get("version")).to_string(),
        user_id: owner.user_id.clone(),
        pairing_kind: if client.is_some() {
            cap_meeting_protocol::PairingKind::StaffClient
        } else {
            cap_meeting_protocol::PairingKind::InternalTeam
        },
        client_id: client.map(|c| c.to_string()),
        title: row.get("title"),
        starts_at: starts,
        ends_at: ends,
    };
    let pairing = match calari::request_pairing(state, &tenant, &req).await {
        Ok(p) => p,
        Err(calari::CalariError::Refused) => {
            return Ok(Prepared::NeedsReview(
                "Calari did not authorize this recording for the staff member and client".into(),
            ))
        }
        Err(e) => anyhow::bail!("{e}"),
    };
    let pairing_uuid =
        ids::parse_uuid(&pairing.pairing_id).context("Calari returned an invalid pairing id")?;
    let code = ids::normalize_pairing_code(&pairing.code)
        .context("Calari returned an invalid pairing code")?;
    let expected_kind = if client.is_some() {
        "staff_client"
    } else {
        "internal_team"
    };
    let token = ids::new_device_token();
    let device_hash = ids::sha256_hex(token.as_bytes());
    let mut tx = state.db.begin().await?;
    // The pairing must be the one Calari just created for exactly this
    // routing, and still unredeemed. Anything else is refused.
    let redeemed = sqlx::query(
        "UPDATE meeting_pairings SET redeemed_at = now()
         WHERE id = $1 AND code_hash = $2 AND tenant_id = $3 AND redeemed_at IS NULL AND expires_at > now()
           AND pairing_kind = $4 AND client_id IS NOT DISTINCT FROM $5
         RETURNING id",
    )
    .bind(pairing_uuid)
    .bind(ids::sha256_hex(code.as_bytes()))
    .bind(&tenant)
    .bind(expected_kind)
    .bind(client)
    .fetch_optional(&mut *tx)
    .await?;
    if redeemed.is_none() {
        return Ok(Prepared::NeedsReview(
            "Calari's pairing did not match this meeting's routing".into(),
        ));
    }
    let name: String = format!("Calendar bot: {}", row.get::<String, _>("title"))
        .chars()
        .take(80)
        .collect();
    sqlx::query(
        "INSERT INTO meeting_devices (token_hash, pairing_id, device_name, device_kind, expires_at) VALUES ($1, $2, $3, 'calendar_bot', $4)",
    )
    .bind(&device_hash)
    .bind(pairing_uuid)
    .bind(&name)
    .bind(ends + Duration::hours(12))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let sealed = crypto::seal(
        &cal.encryption_key.0,
        &cal.encryption_key_id,
        PURPOSE_DEVICE,
        &id.to_string(),
        token.as_bytes(),
    )?;
    Ok(Prepared::Ready {
        pairing_id: pairing.pairing_id,
        device_hash,
        sealed,
    })
}

/// Lease expiry, unclaimed meetings, and device clean-up.
pub async fn expire(state: &AppState, now: DateTime<Utc>) -> Result<()> {
    // Preparation that crashed mid-way goes back to the queue.
    sqlx::query("UPDATE calendar_attendances SET state = 'scheduled', lease_token = NULL, lease_until = NULL WHERE state = 'preparing' AND lease_until < $1")
        .bind(now)
        .execute(&state.db)
        .await?;
    type Lost = (Uuid, String, Option<Uuid>, i32, DateTime<Utc>);
    let lost: Vec<Lost> = sqlx::query_as(
        "SELECT id, state, meeting_id, attempts, ends_at FROM calendar_attendances
         WHERE lease_until < $1 AND (state IN ('claimed', 'joining', 'waiting', 'recording') OR (state = 'cancelled' AND lease_token IS NOT NULL))",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (id, st, meeting, attempts, ends) in lost {
        let mut tx = state.db.begin().await?;
        let still: Option<String> = sqlx::query_scalar(
            "SELECT state FROM calendar_attendances WHERE id = $1 AND lease_until < $2 FOR UPDATE",
        )
        .bind(id)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        if still.as_deref() != Some(st.as_str()) {
            continue;
        }
        if let Some(m) = meeting {
            finalize_interrupted(&mut tx, m, now).await?;
        }
        let retry = meeting.is_none() && st != "cancelled" && attempts < MAX_CLAIMS && ends > now;
        if retry {
            sqlx::query("UPDATE calendar_attendances SET state = 'ready', lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            log(&mut tx, id, "bot_lost_requeued", None).await?;
        } else {
            let next = if st == "cancelled" {
                "cancelled"
            } else {
                "failed"
            };
            sqlx::query("UPDATE calendar_attendances SET state = $2, lease_token = NULL, lease_until = NULL, failure = coalesce(failure, 'bot stopped responding'), updated_at = now() WHERE id = $1")
                .bind(id)
                .bind(next)
                .execute(&mut *tx)
                .await?;
            log(&mut tx, id, "bot_lost", None).await?;
        }
        tx.commit().await?;
    }
    // Never claimed before the meeting ended.
    sqlx::query("UPDATE calendar_attendances SET state = 'failed', failure = 'no bot runner joined before the meeting ended', updated_at = now() WHERE state = 'ready' AND ends_at < $1")
        .bind(now)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE calendar_attendances SET state = 'cancelled', failure = 'meeting ended while waiting for review', updated_at = now() WHERE state IN ('needs_review', 'scheduled') AND ends_at < $1")
        .bind(now)
        .execute(&state.db)
        .await?;
    // Finished attendances keep no usable device.
    sqlx::query(
        "UPDATE meeting_devices SET revoked_at = $1 WHERE revoked_at IS NULL AND token_hash IN (
           SELECT device_token_hash FROM calendar_attendances WHERE device_token_hash IS NOT NULL
             AND state IN ('completed', 'cancelled', 'failed') AND lease_token IS NULL)",
    )
    .bind(now)
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE calendar_attendances SET device_token_ciphertext = NULL WHERE device_token_ciphertext IS NOT NULL AND state IN ('completed', 'cancelled', 'failed') AND lease_token IS NULL")
        .execute(&state.db)
        .await?;
    Ok(())
}

/// The bot's meeting stops with whatever audio arrived, like an abandoned
/// desktop recording, so it is still transcribed and delivered.
pub async fn finalize_interrupted(
    tx: &mut Transaction<'_, Postgres>,
    meeting: Uuid,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE meeting_sessions m SET state = 'finalized', stop_reason = 'interrupted', partial = true,
            last_seq = (SELECT max(seq) FROM meeting_chunks c WHERE c.meeting_id = m.id),
            ended_at = coalesce(m.last_upload_at, m.started_at), next_attempt_at = $2, updated_at = $2
         WHERE m.id = $1 AND m.state = 'recording' AND EXISTS (SELECT 1 FROM meeting_chunks c WHERE c.meeting_id = m.id)",
    )
    .bind(meeting)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts<'a>(now: DateTime<Utc>, routing: Option<Routing>) -> EventFacts<'a> {
        EventFacts {
            connected: true,
            auto_join: true,
            status: "confirmed",
            self_declined: false,
            self_accepted: true,
            starts_at: Some(now + Duration::minutes(30)),
            ends_at: Some(now + Duration::minutes(60)),
            meet_code: Some("abc-defg-hij"),
            choice: "auto",
            routing,
        }
    }

    #[test]
    fn routing_is_explicit_or_unambiguous() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let cands = json!([{"email":"x@acme.com","client_id":a.to_string(),"name":"A"},{"email":"y@beta.com","client_id":b.to_string(),"name":"B"}]);
        assert_eq!(
            routing_for("auto", None, &cands, &["x@acme.com".into()]),
            Some(Routing::Client(a))
        );
        assert_eq!(
            routing_for(
                "auto",
                None,
                &cands,
                &["x@acme.com".into(), "y@beta.com".into()]
            ),
            None
        );
        assert_eq!(
            routing_for("auto", None, &json!([]), &["x@acme.com".into()]),
            None
        );
        assert_eq!(
            routing_for("internal", None, &cands, &[]),
            Some(Routing::Internal)
        );
        assert_eq!(
            routing_for("client", Some(b), &cands, &["x@acme.com".into()]),
            Some(Routing::Client(b))
        );
        assert_eq!(
            routing_for("skip", None, &cands, &["x@acme.com".into()]),
            None
        );
        // Garbage in candidates never routes.
        assert_eq!(
            routing_for(
                "auto",
                None,
                &json!([{"email":"x@acme.com","client_id":"not-a-uuid"}]),
                &["x@acme.com".into()]
            ),
            None
        );
    }

    #[test]
    fn plans() {
        let now = Utc::now();
        let c = Routing::Client(Uuid::new_v4());
        assert!(matches!(
            plan(facts(now, Some(c.clone())), now),
            Plan::Schedule { .. }
        ));
        assert_eq!(plan(facts(now, None), now), Plan::NeedsReview);
        let mut f = facts(now, Some(c.clone()));
        f.choice = "skip";
        assert_eq!(plan(f, now), Plan::Cancel);
        let mut f = facts(now, Some(c.clone()));
        f.status = "cancelled";
        assert_eq!(plan(f, now), Plan::Cancel);
        let mut f = facts(now, Some(c.clone()));
        f.self_accepted = false;
        assert_eq!(
            plan(f, now),
            Plan::Cancel,
            "unanswered invites never schedule"
        );
        let mut f = facts(now, Some(c.clone()));
        f.meet_code = None;
        assert_eq!(plan(f, now), Plan::Cancel);
        let mut f = facts(now, Some(c));
        f.auto_join = false;
        assert_eq!(plan(f, now), Plan::Cancel);
    }

    #[test]
    fn pairing_request_ids_are_stable_per_version() {
        let a = Uuid::new_v4();
        assert_eq!(pairing_request_id(a, 1), pairing_request_id(a, 1));
        assert_ne!(pairing_request_id(a, 1), pairing_request_id(a, 2));
    }
}
