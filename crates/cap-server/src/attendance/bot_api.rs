//! API for the isolated attendance runner. The runner authenticates with
//! its own bearer token, never sees Google or Calari credentials, and gets
//! only a Meet code (not a URL) plus a one-meeting device token for the
//! normal upload API. Every report carries the lease token it claimed with.

use super::{crypto, PURPOSE_DEVICE};
use crate::{error::ApiError, AppState};
use axum::{
    extract::{FromRequestParts, Path, State},
    http::{header, request::Parts, StatusCode},
    response::IntoResponse,
    Json,
};
use cap_meeting_protocol::ids;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

/// Longest a bot may stay after the scheduled end before it must leave.
pub const OVERRUN_MINUTES: i64 = 30;

/// The configured runner, authenticated by a constant-time hash compare.
pub struct Runner;

fn eq_ct(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl FromRequestParts<AppState> for Runner {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized");
        let cal = state
            .cfg
            .calendar
            .as_ref()
            .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))?;
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| !t.is_empty() && t.len() <= 256)
            .ok_or_else(unauthorized)?;
        if !eq_ct(
            ids::sha256_hex(token.as_bytes()).as_bytes(),
            cal.bot_token_sha256.as_bytes(),
        ) {
            return Err(unauthorized());
        }
        Ok(Runner)
    }
}

#[derive(Serialize, Deserialize)]
pub struct Claim {
    pub attendance_id: Uuid,
    pub lease_token: Uuid,
    pub meet_code: String,
    pub title: String,
    pub display_name: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    /// Hard stop: leave by then whatever happens.
    pub leave_by: DateTime<Utc>,
    pub device_token: String,
    pub lease_seconds: i64,
}

impl std::fmt::Debug for Claim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Claim")
            .field("attendance_id", &self.attendance_id)
            .field("meet_code", &self.meet_code)
            .field("device_token", &"<redacted>")
            .field("lease_token", &"<redacted>")
            .finish()
    }
}

impl std::fmt::Debug for Runner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Runner")
    }
}

/// POST /v1/calendar-bot/claim → 200 with a job, or 204 when nothing is due
/// or the concurrency cap is reached.
pub async fn claim(
    State(state): State<AppState>,
    _r: Runner,
) -> Result<axum::response::Response, ApiError> {
    let cal = state.cfg.calendar.as_ref().ok_or(ApiError::internal())?;
    let now = Utc::now();
    let lead = Duration::from_std(cal.join_lead).unwrap_or(Duration::minutes(2));
    let mut tx = state.db.begin().await?;
    // One claimer at a time, so the cap holds across server instances.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('cap.calendar.claim', 7))")
        .execute(&mut *tx)
        .await?;
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM calendar_attendances WHERE lease_until > $1
           AND (state IN ('claimed', 'joining', 'waiting', 'recording') OR (state = 'cancelled' AND lease_token IS NOT NULL))",
    )
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    if active >= i64::from(cal.max_concurrent) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let token = Uuid::new_v4();
    let row = sqlx::query(
        "UPDATE calendar_attendances SET state = 'claimed', lease_token = $3, lease_until = $1 + make_interval(secs => $4),
                attempts = attempts + 1, updated_at = now()
         WHERE id = (SELECT id FROM calendar_attendances WHERE state = 'ready' AND starts_at - $2 <= $1 AND ends_at > $1
                     ORDER BY starts_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, meet_code, title, starts_at, ends_at, device_token_ciphertext",
    )
    .bind(now)
    .bind(lead)
    .bind(token)
    .bind(cal.bot_lease_seconds as f64)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    let id: Uuid = row.get("id");
    let sealed: Option<Vec<u8>> = row.get("device_token_ciphertext");
    let device_token = sealed.as_deref().and_then(|s| {
        crypto::open(
            &cal.encryption_key.0,
            &cal.encryption_key_id,
            PURPOSE_DEVICE,
            &id.to_string(),
            s,
        )
        .ok()
    });
    let Some(device_token) = device_token else {
        sqlx::query("UPDATE calendar_attendances SET state = 'failed', failure = 'bot device credential unreadable', lease_token = NULL, lease_until = NULL WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    sqlx::query("INSERT INTO calendar_attendance_log (attendance_id, kind) VALUES ($1, 'claimed')")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let ends: DateTime<Utc> = row.get("ends_at");
    Ok(Json(Claim {
        attendance_id: id,
        lease_token: token,
        meet_code: row.get("meet_code"),
        title: row.get("title"),
        display_name: cal.bot_display_name.clone(),
        starts_at: row.get("starts_at"),
        ends_at: ends,
        leave_by: ends + Duration::minutes(OVERRUN_MINUTES),
        device_token,
        lease_seconds: cal.bot_lease_seconds,
    })
    .into_response())
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub lease_token: Uuid,
    /// joining | waiting | recording | completed | failed
    pub state: String,
    #[serde(default)]
    pub meeting_id: Option<Uuid>,
    #[serde(default)]
    pub detail: Option<String>,
}

impl std::fmt::Debug for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Report")
            .field("state", &self.state)
            .field("lease_token", &"<redacted>")
            .finish()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReportAnswer {
    /// false: leave the meeting now (cancelled, or past the hard stop).
    #[serde(rename = "continue")]
    pub keep_going: bool,
    pub leave_by: DateTime<Utc>,
    /// The lease now runs this long from when the server handled the report.
    /// A runner must stop capturing once it cannot confirm a renewal within
    /// this time of sending one.
    pub lease_seconds: i64,
}

fn rank(state: &str) -> Option<u8> {
    Some(match state {
        "claimed" => 0,
        "joining" => 1,
        "waiting" => 2,
        "recording" => 3,
        "completed" | "failed" => 4,
        _ => return None,
    })
}

/// POST /v1/calendar-bot/attendances/{id}/report
pub async fn report(
    State(state): State<AppState>,
    _r: Runner,
    Path(id): Path<Uuid>,
    Json(req): Json<Report>,
) -> Result<impl IntoResponse, ApiError> {
    let now = Utc::now();
    let lease_seconds = state
        .cfg
        .calendar
        .as_ref()
        .map(|c| c.bot_lease_seconds)
        .ok_or(ApiError::internal())?;
    let to = rank(&req.state)
        .filter(|r| *r > 0)
        .ok_or(ApiError::bad("invalid_state"))?;
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "SELECT state, ends_at, meeting_id, device_token_hash, meet_code FROM calendar_attendances
         WHERE id = $1 AND lease_token = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(req.lease_token)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "lease_lost"))?;
    let current: String = row.get("state");
    let cancelled = current == "cancelled";
    let ends: DateTime<Utc> = row.get("ends_at");
    let leave_by = ends + Duration::minutes(OVERRUN_MINUTES);
    if !cancelled {
        let from =
            rank(&current).ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "lease_lost"))?;
        // Forward only; a repeated report of the same state is a heartbeat.
        if to < from {
            return Err(ApiError::new(StatusCode::CONFLICT, "invalid_transition"));
        }
    }
    if let Some(m) = req.meeting_id {
        // The meeting must have been created with this attendance's device.
        let owned: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM meeting_sessions WHERE id = $1 AND device_token_hash = $2",
        )
        .bind(m)
        .bind(row.get::<Option<String>, _>("device_token_hash"))
        .fetch_optional(&mut *tx)
        .await?;
        let existing: Option<Uuid> = row.get("meeting_id");
        if owned.is_none() || existing.is_some_and(|e| e != m) {
            return Err(ApiError::new(StatusCode::CONFLICT, "meeting_mismatch"));
        }
        if existing.is_none() {
            let code: String = row.get("meet_code");
            sqlx::query("UPDATE calendar_attendances SET meeting_id = $2 WHERE id = $1")
                .bind(id)
                .bind(m)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE meeting_sessions SET meeting_url = $2, provider_hint = 'google_meet' WHERE id = $1")
                .bind(m)
                .bind(format!("https://meet.google.com/{code}"))
                .execute(&mut *tx)
                .await?;
        }
    }
    let terminal = to == 4;
    let detail = req
        .detail
        .as_deref()
        .and_then(|d| cap_meeting_protocol::clean_text(d, 200));
    let next_state = if cancelled {
        "cancelled".to_owned()
    } else {
        req.state.clone()
    };
    if terminal {
        sqlx::query(
            "UPDATE calendar_attendances SET state = $2, lease_token = NULL, lease_until = NULL,
                    failure = CASE WHEN $2 = 'failed' THEN $3 ELSE failure END, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&next_state)
        .bind(&detail)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "UPDATE calendar_attendances SET state = $2, lease_until = $3, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&next_state)
        .bind(now + Duration::seconds(lease_seconds))
        .execute(&mut *tx)
        .await?;
    }
    if current != req.state || detail.is_some() {
        sqlx::query(
            "INSERT INTO calendar_attendance_log (attendance_id, kind, detail) VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(format!("bot_{}", req.state))
        .bind(&detail)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(ReportAnswer {
        keep_going: !cancelled && !terminal && now < leave_by,
        leave_by,
        lease_seconds,
    }))
}
