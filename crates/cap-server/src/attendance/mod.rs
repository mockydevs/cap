//! Calendar attendance: a Calari staff member connects their Google Calendar
//! once; Cap syncs it, schedules one bot per Google Meet meeting, and the
//! isolated bot runner joins, records and uploads through the normal meeting
//! pipeline (Whisper → signed Calari delivery).
//!
//! Policy lives in [`crate::calendar`]; Google transport in
//! [`crate::google_calendar`]. Nothing here runs unless `CAP_CALENDAR_ENABLED`.

pub mod bot_api;
pub mod calari;
pub mod crypto;
pub mod schedule;
pub mod sync;
pub mod web;

use crate::{config::CalendarConfig, AppState};
use anyhow::Result;
use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

pub const PURPOSE_REFRESH: &str = "google-refresh";
pub const PURPOSE_DEVICE: &str = "bot-device";

/// A stored calendar connection (one per Calari staff member and provider).
#[derive(Clone, Debug)]
pub struct Connection {
    pub id: Uuid,
    pub tenant_id: String,
    pub user_id: String,
    pub status: String,
    pub account_email: String,
    pub auto_join: bool,
    refresh_ciphertext: Option<Vec<u8>>,
    key_id: Option<String>,
}

impl Connection {
    pub async fn load(state: &AppState, id: Uuid) -> Result<Self> {
        let r = sqlx::query(
            "SELECT id, tenant_id, calari_user_id, status, account_email, auto_join, refresh_ciphertext, key_id
             FROM calendar_connections WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
        Ok(Self::from_row(&r))
    }

    pub async fn for_user(
        state: &AppState,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Option<Self>> {
        let r = sqlx::query(
            "SELECT id, tenant_id, calari_user_id, status, account_email, auto_join, refresh_ciphertext, key_id
             FROM calendar_connections WHERE tenant_id = $1 AND calari_user_id = $2 AND provider = 'google'",
        )
        .bind(tenant_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
        Ok(r.as_ref().map(Self::from_row))
    }

    fn from_row(r: &sqlx::postgres::PgRow) -> Self {
        Self {
            id: r.get("id"),
            tenant_id: r.get("tenant_id"),
            user_id: r.get("calari_user_id"),
            status: r.get("status"),
            account_email: r.get("account_email"),
            auto_join: r.get("auto_join"),
            refresh_ciphertext: r.get("refresh_ciphertext"),
            key_id: r.get("key_id"),
        }
    }

    pub fn refresh_token(&self, cal: &CalendarConfig) -> Result<String, crypto::DecryptError> {
        let (Some(sealed), Some(key_id)) = (&self.refresh_ciphertext, &self.key_id) else {
            return Err(crypto::DecryptError);
        };
        if *key_id != cal.encryption_key_id {
            return Err(crypto::DecryptError);
        }
        crypto::open(
            &cal.encryption_key.0,
            key_id,
            PURPOSE_REFRESH,
            &self.id.to_string(),
            sealed,
        )
    }
}

/// Google access lost: keep the row so the staff member sees why, cancel all
/// future attendance, and wait for them to reconnect.
pub async fn mark_needs_reconnect(state: &AppState, id: Uuid, why: &str) -> Result<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE calendar_connections SET status = 'needs_reconnect', refresh_ciphertext = NULL,
                sync_token = NULL, page_token = NULL, sync_run_token = NULL, last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'active'",
    )
    .bind(id)
    .bind(why)
    .execute(&mut *tx)
    .await?;
    schedule::cancel_for_connection(&mut tx, id, why).await?;
    delete_events(&mut tx, id).await?;
    tx.commit().await?;
    tracing::info!(connection = %id, why, "calendar connection needs reconnecting");
    Ok(())
}

/// Disconnect or staff revoked: delete the credential (after revoking it at
/// Google when possible) and cancel everything queued for this connection.
pub async fn revoke_connection(state: &AppState, id: Uuid, why: &str) -> Result<()> {
    let conn = Connection::load(state, id).await?;
    if let Some(cal) = state.cfg.calendar.as_ref() {
        if let Ok(token) = conn.refresh_token(cal) {
            if !crate::google_calendar::revoke(&state.http, cal, &token).await {
                tracing::warn!(connection = %id, "Google token revocation failed; credential deleted locally");
            }
        }
    }
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE calendar_connections SET status = 'revoked', refresh_ciphertext = NULL, key_id = NULL,
                sync_token = NULL, page_token = NULL, sync_run_token = NULL, last_error = $2, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(why)
    .execute(&mut *tx)
    .await?;
    schedule::cancel_for_connection(&mut tx, id, why).await?;
    delete_events(&mut tx, id).await?;
    tx.commit().await?;
    tracing::info!(connection = %id, why, "calendar connection revoked");
    Ok(())
}

/// Event titles and attendee lists do not outlive the connection.
async fn delete_events(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM calendar_events WHERE connection_id = $1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// One pass: sync due calendars, then advance the schedule.
pub async fn run_once(state: &AppState) -> Result<()> {
    for _ in 0..5 {
        if !sync::sync_due(state, Utc::now()).await? {
            break;
        }
    }
    schedule::tick(state, Utc::now()).await
}

pub async fn run(state: AppState) {
    loop {
        if let Err(e) = run_once(&state).await {
            tracing::error!(error = %e, "calendar attendance iteration failed");
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
