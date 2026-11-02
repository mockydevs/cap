//! Calendar sync for one leased connection.
//!
//! Bounded: every run lists one rolling window (`now − 1 h` to
//! `now + horizon`) with recurring series expanded into instances, so an
//! endless series yields a finite listing and new instances enter as the
//! window moves. Durable cursor: `page_token` is saved with each page's events
//! in one transaction, so a crash or error resumes at the next page of the
//! same window. Events inside the window that a complete run did not see were
//! deleted (or moved out) and are cancelled.

use super::{calari, schedule, Connection};
use crate::{
    google_calendar::{self as google, CalendarError, CalendarEvent},
    AppState,
};
use anyhow::Result;
use cap_meeting_protocol::CalendarClientMapping;
use chrono::{DateTime, Duration, SubsecRound, TimeZone, Utc};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

const LEASE_MINUTES: i32 = 5;
/// Pages stored per claim; a larger calendar continues on the next claim.
pub const PAGES_PER_CLAIM: usize = 20;

#[derive(Clone, Copy, Debug)]
pub struct SyncLease {
    pub id: Uuid,
    pub token: Uuid,
}

#[derive(Debug, thiserror::Error)]
#[error("another worker took over this calendar sync")]
pub struct LostSyncLease;

/// Claims at most one due connection. Returns whether one was processed.
pub async fn sync_due(state: &AppState, now: DateTime<Utc>) -> Result<bool> {
    let token = Uuid::new_v4();
    let id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE calendar_connections SET sync_lease_token = $2, sync_lease_until = $1 + make_interval(mins => $3),
                sync_attempts = sync_attempts + 1
         WHERE id = (SELECT id FROM calendar_connections
                     WHERE status = 'active' AND next_sync_at <= $1
                       AND (sync_lease_until IS NULL OR sync_lease_until < $1)
                     ORDER BY next_sync_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id",
    )
    .bind(now)
    .bind(token)
    .bind(LEASE_MINUTES)
    .fetch_optional(&state.db)
    .await?;
    let Some(id) = id else { return Ok(false) };
    let lease = SyncLease { id, token };
    let outcome = sync_connection(state, lease, now).await;
    let (next, error) = match &outcome {
        Ok(Outcome::Done) => (now + interval(state), None),
        Ok(Outcome::MorePages) => (now, None),
        Ok(Outcome::Stopped) => (now + interval(state), None),
        Err(e) if e.downcast_ref::<LostSyncLease>().is_some() => return Ok(true),
        Err(e) => {
            tracing::warn!(connection = %id, error = %e, "calendar sync failed; will retry");
            let attempts: i32 =
                sqlx::query_scalar("SELECT sync_attempts FROM calendar_connections WHERE id = $1")
                    .bind(id)
                    .fetch_one(&state.db)
                    .await?;
            (
                now + crate::meetings::worker::backoff(attempts),
                Some(format!("{e}").chars().take(300).collect::<String>()),
            )
        }
    };
    sqlx::query(
        "UPDATE calendar_connections SET sync_lease_token = NULL, sync_lease_until = NULL, next_sync_at = $3,
                last_error = $4, sync_attempts = CASE WHEN $4::text IS NULL THEN 0 ELSE sync_attempts END,
                last_synced_at = CASE WHEN $4::text IS NULL THEN now() ELSE last_synced_at END, updated_at = now()
         WHERE id = $1 AND sync_lease_token = $2",
    )
    .bind(id)
    .bind(token)
    .bind(next)
    .bind(error)
    .execute(&state.db)
    .await?;
    Ok(true)
}

fn interval(state: &AppState) -> Duration {
    state
        .cfg
        .calendar
        .as_ref()
        .and_then(|c| Duration::from_std(c.sync_interval).ok())
        .unwrap_or(Duration::minutes(5))
}

pub enum Outcome {
    Done,
    MorePages,
    /// Connection needs reconnecting or was revoked.
    Stopped,
}

async fn hold(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, lease: SyncLease) -> Result<()> {
    let held: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM calendar_connections WHERE id = $1 AND sync_lease_token = $2 AND status = 'active' FOR UPDATE",
    )
    .bind(lease.id)
    .bind(lease.token)
    .fetch_optional(&mut **tx)
    .await?;
    held.map(|_| ()).ok_or_else(|| LostSyncLease.into())
}

/// A run is persisted in `sync_run_token` as `w:<id>:<unix min>:<unix max>`.
fn parse_run(run: &str) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let mut parts = run.split(':');
    match (
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next(),
    ) {
        ("w", _, min, max, None) => Some((
            Utc.timestamp_opt(min.parse().ok()?, 0).single()?,
            Utc.timestamp_opt(max.parse().ok()?, 0).single()?,
        )),
        _ => None,
    }
}

fn horizon(state: &AppState) -> Duration {
    state
        .cfg
        .calendar
        .as_ref()
        .and_then(|c| Duration::from_std(c.horizon).ok())
        .unwrap_or(Duration::days(14))
}

pub async fn sync_connection(
    state: &AppState,
    lease: SyncLease,
    now: DateTime<Utc>,
) -> Result<Outcome> {
    let Some(cal) = state.cfg.calendar.as_ref() else {
        return Ok(Outcome::Stopped);
    };
    let conn = Connection::load(state, lease.id).await?;
    let refresh = match conn.refresh_token(cal) {
        Ok(t) => t,
        Err(_) => {
            super::mark_needs_reconnect(state, lease.id, "stored credential unreadable").await?;
            return Ok(Outcome::Stopped);
        }
    };
    let access = match google::refresh(&state.http, cal, &refresh).await {
        Ok(a) => a,
        Err(CalendarError::Reconnect) => {
            super::mark_needs_reconnect(state, lease.id, "Google access was revoked or expired")
                .await?;
            return Ok(Outcome::Stopped);
        }
        Err(e) => anyhow::bail!("refreshing Google access failed: {e}"),
    };

    let row =
        sqlx::query("SELECT page_token, sync_run_token FROM calendar_connections WHERE id = $1")
            .bind(lease.id)
            .fetch_one(&state.db)
            .await?;
    let stored: Option<String> = row.get("sync_run_token");
    let (run, (time_min, time_max), mut page) = match stored
        .as_deref()
        .and_then(|r| parse_run(r).map(|w| (r.to_owned(), w)))
    {
        Some((run, window)) => (run, window, row.get::<Option<String>, _>("page_token")),
        None => {
            let window = (
                (now - Duration::hours(1)).trunc_subsecs(0),
                (now + horizon(state)).trunc_subsecs(0),
            );
            let run = format!(
                "w:{}:{}:{}",
                Uuid::new_v4().simple(),
                window.0.timestamp(),
                window.1.timestamp()
            );
            let mut tx = state.db.begin().await?;
            hold(&mut tx, lease).await?;
            sqlx::query("UPDATE calendar_connections SET sync_run_token = $2, page_token = NULL WHERE id = $1")
                .bind(lease.id)
                .bind(&run)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            (run, window, None)
        }
    };

    for _ in 0..PAGES_PER_CLAIM {
        let result = google::primary_events(
            &state.http,
            &cal.google.api_base,
            &access,
            page.as_deref(),
            time_min,
            time_max,
        )
        .await;
        let data = match result {
            Ok(d) => d,
            Err(CalendarError::FullResync) => {
                // The page token expired: start a fresh window.
                let mut tx = state.db.begin().await?;
                hold(&mut tx, lease).await?;
                sqlx::query("UPDATE calendar_connections SET page_token = NULL, sync_run_token = NULL WHERE id = $1")
                    .bind(lease.id)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(Outcome::MorePages);
            }
            Err(CalendarError::Reconnect) => {
                super::mark_needs_reconnect(state, lease.id, "Google refused calendar access")
                    .await?;
                return Ok(Outcome::Stopped);
            }
            Err(e) => anyhow::bail!("reading Google Calendar failed: {e}"),
        };
        let mut tx = state.db.begin().await?;
        hold(&mut tx, lease).await?;
        for event in &data.items {
            store_event(&mut tx, lease.id, event, &run).await?;
        }
        let finished = data.next_page_token.is_none();
        if finished {
            // In the window but not listed: deleted or moved out.
            sqlx::query(
                "UPDATE calendar_events SET status = 'cancelled', updated_at = now()
                 WHERE connection_id = $1 AND seen_run IS DISTINCT FROM $2 AND status <> 'cancelled'
                   AND ends_at > $3 AND starts_at < $4",
            )
            .bind(lease.id)
            .bind(&run)
            .bind(time_min)
            .bind(time_max)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE calendar_connections SET page_token = NULL, sync_run_token = NULL WHERE id = $1")
                .bind(lease.id)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE calendar_connections SET page_token = $2 WHERE id = $1")
                .bind(lease.id)
                .bind(&data.next_page_token)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        if finished {
            refresh_routing(state, &conn, now).await?;
            schedule::reconcile_connection(state, lease.id, now).await?;
            return Ok(Outcome::Done);
        }
        page = data.next_page_token;
    }
    Ok(Outcome::MorePages)
}

async fn store_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    connection_id: Uuid,
    event: &CalendarEvent,
    run: &str,
) -> Result<()> {
    if event.id.is_empty() || event.id.len() > 1024 {
        return Ok(());
    }
    let starts = event.start.as_ref().and_then(|t| t.date_time);
    let ends = event.end.as_ref().and_then(|t| t.date_time);
    let title = event
        .summary
        .as_deref()
        .and_then(|s| cap_meeting_protocol::clean_text(s, 200))
        .unwrap_or_else(|| "Calendar meeting".into());
    let code = event.meet_url().and_then(crate::calendar::google_meet_code);
    if code.is_none() {
        // Not a Google Meet meeting: keep nothing about it. A stored meeting
        // that lost its Meet link is cancelled.
        sqlx::query(
            "UPDATE calendar_events SET status = 'cancelled', meet_code = NULL, seen_run = $3, updated_at = now()
             WHERE connection_id = $1 AND event_id = $2",
        )
        .bind(connection_id)
        .bind(&event.id)
        .bind(run)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    let status = if event.is_cancelled() {
        "cancelled"
    } else {
        "confirmed"
    };
    // Stale updates (an older `updated` than stored) are ignored, except that
    // a full run still records that it saw the event.
    sqlx::query(
        "INSERT INTO calendar_events (connection_id, event_id, status, title, starts_at, ends_at, meet_code,
                                      attendee_emails, self_declined, google_updated, seen_run, self_accepted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (connection_id, event_id) DO UPDATE SET
           status = CASE WHEN stale THEN calendar_events.status ELSE EXCLUDED.status END,
           title = CASE WHEN stale THEN calendar_events.title ELSE EXCLUDED.title END,
           starts_at = CASE WHEN stale THEN calendar_events.starts_at ELSE EXCLUDED.starts_at END,
           ends_at = CASE WHEN stale THEN calendar_events.ends_at ELSE EXCLUDED.ends_at END,
           meet_code = CASE WHEN stale THEN calendar_events.meet_code ELSE EXCLUDED.meet_code END,
           attendee_emails = CASE WHEN stale THEN calendar_events.attendee_emails ELSE EXCLUDED.attendee_emails END,
           self_declined = CASE WHEN stale THEN calendar_events.self_declined ELSE EXCLUDED.self_declined END,
           self_accepted = CASE WHEN stale THEN calendar_events.self_accepted ELSE EXCLUDED.self_accepted END,
           google_updated = CASE WHEN stale THEN calendar_events.google_updated ELSE EXCLUDED.google_updated END,
           seen_run = EXCLUDED.seen_run,
           updated_at = now()"
            .replace(
                "stale",
                "(calendar_events.google_updated IS NOT NULL AND EXCLUDED.google_updated IS NOT NULL
                  AND EXCLUDED.google_updated < calendar_events.google_updated)",
            )
            .as_str(),
    )
    .bind(connection_id)
    .bind(&event.id)
    .bind(status)
    .bind(&title)
    .bind(starts)
    .bind(ends)
    .bind(code)
    .bind(json!(event.other_attendee_emails()))
    .bind(event.self_declined())
    .bind(event.updated)
    .bind(run)
    .bind(event.self_accepted())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Asks Calari for the staff member's status and the verified client of
/// each upcoming meeting's attendees. Staff no longer active → revoked.
pub async fn refresh_routing(
    state: &AppState,
    conn: &Connection,
    now: DateTime<Utc>,
) -> Result<()> {
    let horizon = state
        .cfg
        .calendar
        .as_ref()
        .and_then(|c| Duration::from_std(c.horizon).ok())
        .unwrap_or(Duration::days(14));
    let rows = sqlx::query(
        "SELECT event_id, attendee_emails FROM calendar_events
         WHERE connection_id = $1 AND status <> 'cancelled' AND meet_code IS NOT NULL
           AND ends_at > $2 AND starts_at < $3",
    )
    .bind(conn.id)
    .bind(now)
    .bind(now + horizon)
    .fetch_all(&state.db)
    .await?;
    let mut emails: Vec<String> = rows
        .iter()
        .filter_map(|r| serde_json::from_value::<Vec<String>>(r.get("attendee_emails")).ok())
        .flatten()
        .collect();
    emails.sort();
    emails.dedup();
    let resolved = match calari::resolve(state, &conn.tenant_id, &conn.user_id, &emails).await {
        Ok(r) => r,
        Err(calari::CalariError::Refused) => {
            super::revoke_connection(
                state,
                conn.id,
                "Calari no longer recognises this staff member",
            )
            .await?;
            return Ok(());
        }
        Err(e) => anyhow::bail!("{e}"),
    };
    if !resolved.active {
        super::revoke_connection(state, conn.id, "staff member is no longer active in Calari")
            .await?;
        return Ok(());
    }
    let mut tx = state.db.begin().await?;
    for r in &rows {
        let mine: Vec<String> =
            serde_json::from_value(r.get("attendee_emails")).unwrap_or_default();
        let candidates: Vec<&CalendarClientMapping> = resolved
            .mappings
            .iter()
            .filter(|m| mine.contains(&m.email.trim().to_lowercase()))
            .collect();
        let value = json!(candidates
            .iter()
            .map(|m| json!({
                "email": m.email.trim().to_lowercase(),
                "client_id": m.client_id,
                "name": cap_meeting_protocol::clean_text(&m.client_display_name, 120).unwrap_or_else(|| "Client".into()),
            }))
            .collect::<Vec<_>>());
        sqlx::query(
            "UPDATE calendar_events SET candidates = $3 WHERE connection_id = $1 AND event_id = $2",
        )
        .bind(conn.id)
        .bind(r.get::<String, _>("event_id"))
        .bind(value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run_tokens_round_trip() {
        let (min, max) = parse_run("w:abc:1762000000:1763000000").unwrap();
        assert_eq!(
            (min.timestamp(), max.timestamp()),
            (1_762_000_000, 1_763_000_000)
        );
        for bad in ["i:abc", "f:abc:1", "w:abc:1", "w:abc:x:1", "w:a:1:2:3"] {
            assert_eq!(parse_run(bad), None, "{bad}");
        }
    }
}
