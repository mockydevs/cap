//! Background processing: finalized meeting → transcript → signed delivery.
//!
//! Each meeting is one job row (`meeting_sessions`) leased with
//! `FOR UPDATE SKIP LOCKED`, so several server instances can run workers
//! without processing the same meeting twice. Every step is resumable: chunk
//! transcripts are cached, the delivery body is frozen once built, and a
//! crash leaves the meeting in the step it was in.

use super::transcribe::{ChunkInput, ChunkSegment, TranscribeError};
use crate::AppState;
use anyhow::{anyhow, Context, Result};
use cap_meeting_protocol::{
    audio::AudioContainer,
    delivery_event_id, ids,
    signing::{self, Purpose},
    transcript_digest, CaptureMode, DeliveredMeeting, DeliveredTranscript, DeliveryAck,
    DeliveryContext, DeliveryPayload, DeviceKind, MeetingState, PairingKind, StopReason,
    TranscriptSegment, Transition, DELIVERY_SCHEMA, EVENT_TRANSCRIPT_COMPLETED,
};
use chrono::{DateTime, Duration, Utc};
use sqlx::Row;
use uuid::Uuid;

pub const MAX_ATTEMPTS: i32 = 8;
const LEASE_MINUTES: i64 = 15;

/// Exponential backoff: 30 s, 1 m, 2 m … capped at 30 minutes.
pub fn backoff(attempt: i32) -> Duration {
    let secs = 30_i64.saturating_mul(1_i64 << attempt.clamp(1, 7).saturating_sub(1));
    Duration::seconds(secs.min(1_800))
}

/// A claim on one meeting. `token` fences every write: a worker whose lease
/// expired and was taken over can no longer change the meeting.
#[derive(Clone, Copy, Debug)]
pub struct Lease {
    pub id: Uuid,
    pub token: Uuid,
}

#[derive(Debug, thiserror::Error)]
#[error("another worker took over this meeting")]
pub struct LostLease;

impl Lease {
    /// Extends the lease, or fails if another worker owns the meeting now.
    pub async fn renew(&self, state: &AppState) -> Result<()> {
        let rows = sqlx::query(
            "UPDATE meeting_sessions SET lease_until = greatest(lease_until, now() + make_interval(mins => $3))
             WHERE id = $1 AND lease_token = $2",
        )
        .bind(self.id)
        .bind(self.token)
        .bind(LEASE_MINUTES as i32)
        .execute(&state.db)
        .await?
        .rows_affected();
        if rows == 0 {
            return Err(LostLease.into());
        }
        Ok(())
    }

    /// Locks the meeting row in `tx`, or fails if this worker lost it.
    async fn hold(&self, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) -> Result<()> {
        let held: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM meeting_sessions WHERE id = $1 AND lease_token = $2 FOR UPDATE",
        )
        .bind(self.id)
        .bind(self.token)
        .fetch_optional(&mut **tx)
        .await?;
        held.map(|_| ()).ok_or_else(|| LostLease.into())
    }
}

enum Step {
    Done,
    Retry(String),
    Fail(String),
}

pub async fn run(state: AppState) {
    loop {
        match run_once(&state, Utc::now()).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => tracing::error!(error = %e, "meeting worker iteration failed"),
        }
        tokio::select! {
            _ = tokio::time::sleep(state.cfg.worker_interval) => {}
            _ = state.worker_wake.notified() => {}
        }
    }
}

/// Does housekeeping and processes at most one meeting. Returns whether a
/// meeting was processed, so callers can loop until idle.
pub async fn run_once(state: &AppState, now: DateTime<Utc>) -> Result<bool> {
    housekeeping(state, now).await?;
    let Some(lease) = claim(state, now).await? else {
        return Ok(false);
    };
    work(state, lease, now).await?;
    Ok(true)
}

/// Processes one claimed meeting and records the outcome, fenced by the lease.
pub async fn work(state: &AppState, lease: Lease, now: DateTime<Utc>) -> Result<()> {
    let id = lease.id;
    // Keep the lease alive during long steps; writes stay fenced regardless.
    let renewer = {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if lease.renew(&state).await.is_err() {
                    break;
                }
            }
        })
    };
    let outcome = process(state, lease).await;
    renewer.abort();
    if let Err(e) = &outcome {
        if e.downcast_ref::<LostLease>().is_some() {
            tracing::warn!(meeting = %id, "lease lost to another worker; leaving the meeting to it");
            return Ok(());
        }
    }
    let (step, detail) = match outcome {
        Ok(step) => (step, None),
        Err(e) => {
            let msg = format!("{e:#}");
            (Step::Retry(msg.clone()), Some(msg))
        }
    };
    if let Some(d) = detail {
        tracing::warn!(meeting = %id, error = %d, "meeting step errored");
    }
    finish(state, lease, step, now).await
}

async fn housekeeping(state: &AppState, now: DateTime<Utc>) -> Result<()> {
    let retention = Duration::seconds(signing::NONCE_RETENTION_SECONDS);
    sqlx::query("DELETE FROM meeting_request_nonces WHERE seen_at < $1")
        .bind(now - retention)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM meeting_redeem_failures WHERE at < $1")
        .bind(now - Duration::hours(1))
        .execute(&state.db)
        .await?;
    // A recording whose device vanished (crash, lost network, closed lid) is
    // finalized with the audio that did arrive, rather than lost.
    let abandon = Duration::from_std(state.cfg.abandon_after).unwrap_or(Duration::hours(6));
    let swept = sqlx::query(
        "UPDATE meeting_sessions m SET state = 'finalized', stop_reason = 'interrupted', partial = true,
            last_seq = (SELECT max(seq) FROM meeting_chunks c WHERE c.meeting_id = m.id),
            ended_at = coalesce(m.last_upload_at, m.started_at), next_attempt_at = $1, updated_at = $1
         WHERE m.state = 'recording' AND coalesce(m.last_upload_at, m.created_at) < $2
           AND EXISTS (SELECT 1 FROM meeting_chunks c WHERE c.meeting_id = m.id)",
    )
    .bind(now)
    .bind(now - abandon)
    .execute(&state.db)
    .await?
    .rows_affected();
    if swept > 0 {
        tracing::info!(
            count = swept,
            "finalized abandoned recordings as interrupted"
        );
    }
    Ok(())
}

pub async fn claim(state: &AppState, now: DateTime<Utc>) -> Result<Option<Lease>> {
    let token = Uuid::new_v4();
    let id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE meeting_sessions SET lease_until = $1 + make_interval(mins => $2), lease_token = $3, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM meeting_sessions
           WHERE state IN ('finalized', 'transcribing', 'summarizing', 'delivering')
             AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until < $1)
           ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id",
    )
    .bind(now)
    .bind(LEASE_MINUTES as i32)
    .bind(token)
    .fetch_optional(&state.db)
    .await?;
    Ok(id.map(|id| Lease { id, token }))
}

async fn finish(state: &AppState, lease: Lease, step: Step, now: DateTime<Utc>) -> Result<()> {
    let id = lease.id;
    let rows = match step {
        Step::Done => sqlx::query(
            "UPDATE meeting_sessions SET lease_until = NULL, lease_token = NULL, attempts = 0, failure = NULL, updated_at = now()
             WHERE id = $1 AND lease_token = $2",
        )
        .bind(id)
        .bind(lease.token)
        .execute(&state.db)
        .await?
        .rows_affected(),
        Step::Retry(reason) => {
            let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM meeting_sessions WHERE id = $1")
                .bind(id)
                .fetch_one(&state.db)
                .await?;
            if attempts >= MAX_ATTEMPTS {
                return fail(state, lease, &format!("gave up after {attempts} attempts: {reason}")).await;
            }
            sqlx::query(
                "UPDATE meeting_sessions SET lease_until = NULL, lease_token = NULL, next_attempt_at = $3, failure = $4, updated_at = now()
                 WHERE id = $1 AND lease_token = $2",
            )
            .bind(id)
            .bind(lease.token)
            .bind(now + backoff(attempts))
            .bind(truncate(&reason))
            .execute(&state.db)
            .await?
            .rows_affected()
        }
        Step::Fail(reason) => return fail(state, lease, &reason).await,
    };
    if rows == 0 {
        tracing::warn!(meeting = %id, "lease lost before finishing; another worker owns the meeting");
    }
    Ok(())
}

async fn fail(state: &AppState, lease: Lease, reason: &str) -> Result<()> {
    let mut tx = state.db.begin().await?;
    if lease.hold(&mut tx).await.is_err() {
        tracing::warn!(meeting = %lease.id, "lease lost; not marking the meeting failed");
        return Ok(());
    }
    tracing::error!(meeting = %lease.id, reason, "meeting processing failed permanently; audio is kept");
    sqlx::query(
        "UPDATE meeting_sessions SET state = 'failed', lease_until = NULL, lease_token = NULL, failure = $2, updated_at = now() WHERE id = $1",
    )
    .bind(lease.id)
    .bind(truncate(reason))
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE meeting_deliveries SET status = 'failed' WHERE meeting_id = $1 AND status = 'pending'")
        .bind(lease.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

fn truncate(s: &str) -> String {
    s.chars().take(500).collect()
}

async fn set_state(
    state: &AppState,
    lease: Lease,
    from: MeetingState,
    t: Transition,
) -> Result<MeetingState> {
    let to = from
        .transition(t)
        .ok_or_else(|| anyhow!("illegal transition {from:?} -> {t:?}"))?;
    let rows = sqlx::query(
        "UPDATE meeting_sessions SET state = $3, updated_at = now() WHERE id = $1 AND lease_token = $2 AND state = $4",
    )
    .bind(lease.id)
    .bind(lease.token)
    .bind(to.as_str())
    .bind(from.as_str())
    .execute(&state.db)
    .await?
    .rows_affected();
    if rows == 0 {
        return Err(LostLease.into());
    }
    Ok(to)
}

async fn process(state: &AppState, lease: Lease) -> Result<Step> {
    let id = lease.id;
    let current: String = sqlx::query_scalar("SELECT state FROM meeting_sessions WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let mut current = MeetingState::parse(&current).context("unknown meeting state")?;
    if matches!(
        current,
        MeetingState::Finalized | MeetingState::Transcribing
    ) {
        current = set_state(state, lease, current, Transition::StartTranscription).await?;
        match transcribe_all(state, lease).await? {
            Step::Done => {}
            other => return Ok(other),
        }
        // Calari summarizes once with its own key, so Cap's summary step is a
        // pass-through; the state stays in the lifecycle for other receivers.
        current = set_state(state, lease, current, Transition::StartSummary).await?;
    }
    if current == MeetingState::Summarizing {
        current = set_state(state, lease, current, Transition::StartDelivery).await?;
    }
    if current == MeetingState::Delivering {
        return deliver(state, lease, current).await;
    }
    Ok(Step::Done)
}

async fn transcribe_all(state: &AppState, lease: Lease) -> Result<Step> {
    let id = lease.id;
    let chunks = sqlx::query(
        "SELECT c.seq, c.object_key, c.container, c.start_ms, c.duration_ms, t.segments IS NOT NULL AS done
         FROM meeting_chunks c LEFT JOIN meeting_chunk_transcripts t ON t.meeting_id = c.meeting_id AND t.seq = c.seq
         WHERE c.meeting_id = $1 ORDER BY c.seq",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let mut prompt: Option<String> = None;
    for c in &chunks {
        let seq: i32 = c.get("seq");
        if c.get::<bool, _>("done") {
            prompt = last_words(state, id, seq).await?;
            continue;
        }
        lease.renew(state).await?;
        let bytes = state.store.get(c.get("object_key")).await?;
        let container =
            AudioContainer::from_extension(c.get("container")).context("unknown container")?;
        let file_name = format!("chunk-{seq}.{}", container.extension());
        let result = state
            .transcriber
            .transcribe(ChunkInput {
                bytes: &bytes,
                mime: container.mime(),
                file_name: &file_name,
                seq: seq as u32,
                duration_ms: c.get::<i64, _>("duration_ms") as u64,
                prompt: prompt.as_deref(),
            })
            .await;
        let t = match result {
            Ok(t) => t,
            Err(TranscribeError::Retryable(e)) => return Ok(Step::Retry(e)),
            Err(TranscribeError::Permanent(e)) => return Ok(Step::Fail(e)),
        };
        prompt = tail(&t.segments);
        let mut tx = state.db.begin().await?;
        lease.hold(&mut tx).await?;
        sqlx::query(
            "INSERT INTO meeting_chunk_transcripts (meeting_id, seq, provider, model, language, segments)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(seq)
        .bind(&t.provider)
        .bind(&t.model)
        .bind(&t.language)
        .bind(serde_json::to_value(&t.segments)?)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }

    // Assemble in chunk order with absolute offsets.
    let rows = sqlx::query(
        "SELECT c.start_ms, c.duration_ms, t.provider, t.model, t.language, t.segments FROM meeting_chunk_transcripts t
         JOIN meeting_chunks c ON c.meeting_id = t.meeting_id AND c.seq = t.seq
         WHERE t.meeting_id = $1 ORDER BY t.seq",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let mut segments = Vec::new();
    let (mut provider, mut model, mut language) =
        (String::from("none"), String::from("none"), None);
    for r in rows {
        let offset = r.get::<i64, _>("start_ms").max(0) as u64;
        provider = r.get("provider");
        model = r.get("model");
        language = language.or(r.get::<Option<String>, _>("language"));
        // Whisper pads audio to 30 s windows, so a segment can claim to end
        // after its chunk does; clamp to the chunk's real length.
        let duration = r.get::<i64, _>("duration_ms").max(0) as u64;
        let parts: Vec<ChunkSegment> = serde_json::from_value(r.get("segments"))?;
        for p in parts {
            let start = p.start_ms.min(duration);
            segments.push(TranscriptSegment {
                index: segments.len() as u32,
                start_ms: offset + start,
                end_ms: offset + p.end_ms.clamp(start, duration),
                text: p.text,
            });
        }
    }
    let text = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut tx = state.db.begin().await?;
    lease.hold(&mut tx).await?;
    sqlx::query(
        "INSERT INTO meeting_transcripts (meeting_id, provider, model, language, segments, text, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (meeting_id) DO UPDATE SET provider = $2, model = $3, language = $4, segments = $5, text = $6, sha256 = $7",
    )
    .bind(id)
    .bind(&provider)
    .bind(&model)
    .bind(&language)
    .bind(serde_json::to_value(&segments)?)
    .bind(&text)
    .bind(transcript_digest(&segments))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Step::Done)
}

fn tail(segments: &[ChunkSegment]) -> Option<String> {
    let joined = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<char> = joined.chars().collect();
    (!chars.is_empty()).then(|| chars[chars.len().saturating_sub(200)..].iter().collect())
}

async fn last_words(state: &AppState, id: Uuid, seq: i32) -> Result<Option<String>> {
    let v: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT segments FROM meeting_chunk_transcripts WHERE meeting_id = $1 AND seq = $2",
    )
    .bind(id)
    .bind(seq)
    .fetch_optional(&state.db)
    .await?;
    Ok(
        v.and_then(|v| serde_json::from_value::<Vec<ChunkSegment>>(v).ok())
            .and_then(|s| tail(&s)),
    )
}

/// Builds the delivery body once and stores the exact bytes, so every retry
/// sends identical content (and an identical content hash).
async fn frozen_delivery(
    state: &AppState,
    lease: Lease,
) -> Result<Option<(Uuid, String, String, Vec<u8>, String)>> {
    let id = lease.id;
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM meeting_sessions WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if let Some(r) = sqlx::query(
        "SELECT event_id, key_id, delivery_url, body, body_sha256, status FROM meeting_deliveries WHERE meeting_id = $1 AND revision = $2",
    )
    .bind(id)
    .bind(revision)
    .fetch_optional(&state.db)
    .await?
    {
        if r.get::<String, _>("status") == "delivered" {
            return Ok(None);
        }
        return Ok(Some((r.get("event_id"), r.get("key_id"), r.get("delivery_url"), r.get("body"), r.get("body_sha256"))));
    }
    let m = sqlx::query(
        "SELECT m.title, m.capture_mode, m.provider_hint, m.meeting_url, m.source, m.started_at, m.ended_at, m.stop_reason, m.partial,
                p.id AS pairing_id, p.tenant_id, p.pairing_kind, p.client_id, p.intake_receipt_id,
                t.provider, t.model, t.language, t.segments, t.text, t.sha256
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         JOIN meeting_transcripts t ON t.meeting_id = m.id WHERE m.id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let tenant: String = m.get("tenant_id");
    let integration = state
        .cfg
        .integration_for_tenant(&tenant)
        .with_context(|| format!("no integration configured for tenant {tenant}"))?;
    let started: DateTime<Utc> = m.get("started_at");
    let ended: DateTime<Utc> = m
        .get::<Option<DateTime<Utc>>, _>("ended_at")
        .unwrap_or(started);
    let event_id = delivery_event_id(&id.to_string(), revision as u32);
    let payload = DeliveryPayload {
        schema: DELIVERY_SCHEMA.into(),
        event_id: event_id.clone(),
        event_type: EVENT_TRANSCRIPT_COMPLETED.into(),
        revision: revision as u32,
        tenant_id: tenant,
        client_id: m.get::<Option<Uuid>, _>("client_id").map(|u| u.to_string()),
        pairing_id: m.get::<Uuid, _>("pairing_id").to_string(),
        intake_receipt_id: m
            .get::<Option<Uuid>, _>("intake_receipt_id")
            .map(|u| u.to_string()),
        context: DeliveryContext {
            pairing_kind: PairingKind::parse(m.get("pairing_kind")).context("pairing kind")?,
            capture_mode: CaptureMode::parse(m.get("capture_mode")).context("capture mode")?,
        },
        meeting: DeliveredMeeting {
            id: id.to_string(),
            title: m.get("title"),
            source: DeviceKind::parse(m.get("source")).unwrap_or(DeviceKind::Extension),
            provider_hint: m.get("provider_hint"),
            started_at: started,
            ended_at: ended,
            duration_ms: (ended - started).num_milliseconds().max(0) as u64,
            stop_reason: m
                .get::<Option<String>, _>("stop_reason")
                .and_then(|s| StopReason::parse(&s))
                .unwrap_or(StopReason::Interrupted),
            partial: m.get("partial"),
            // The signed-in meeting page, when library sign-in is set up.
            // Only a real https link: Calari refuses anything else, so a
            // local http server sends none rather than a rejected delivery.
            cap_url: integration
                .login_authorize_url
                .as_ref()
                .filter(|_| state.cfg.public_base_url.starts_with("https://"))
                .map(|_| format!("{}/meetings/{id}", state.cfg.public_base_url)),
            meeting_url: m.get("meeting_url"),
        },
        transcript: DeliveredTranscript {
            provider: m.get("provider"),
            model: m.get("model"),
            language: m.get("language"),
            segments: serde_json::from_value(m.get("segments"))?,
            text: m.get("text"),
            sha256: m.get("sha256"),
        },
        summary: None,
        created_at: Utc::now(),
    };
    let body = serde_json::to_vec(&payload)?;
    let body_sha = ids::sha256_hex(&body);
    let event_uuid = Uuid::parse_str(&event_id)?;
    let mut tx = state.db.begin().await?;
    lease.hold(&mut tx).await?;
    sqlx::query(
        "INSERT INTO meeting_deliveries (event_id, meeting_id, revision, key_id, delivery_url, body, body_sha256, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') ON CONFLICT (meeting_id, revision) DO NOTHING",
    )
    .bind(event_uuid)
    .bind(id)
    .bind(revision)
    .bind(&integration.key_id)
    .bind(&integration.delivery_url)
    .bind(&body)
    .bind(&body_sha)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // Re-read so a concurrent builder's row wins consistently.
    let r = sqlx::query("SELECT event_id, key_id, delivery_url, body, body_sha256 FROM meeting_deliveries WHERE meeting_id = $1 AND revision = $2")
        .bind(id)
        .bind(revision)
        .fetch_one(&state.db)
        .await?;
    Ok(Some((
        r.get("event_id"),
        r.get("key_id"),
        r.get("delivery_url"),
        r.get("body"),
        r.get("body_sha256"),
    )))
}

async fn deliver(state: &AppState, lease: Lease, current: MeetingState) -> Result<Step> {
    let id = lease.id;
    let Some((event_id, key_id, url, body, body_sha)) = frozen_delivery(state, lease).await? else {
        set_state(state, lease, current, Transition::Delivered).await?;
        return Ok(Step::Done);
    };
    let integration = state
        .cfg
        .integration(&key_id)
        .with_context(|| format!("integration {key_id} is no longer configured"))?;
    lease.renew(state).await?;
    let ts = Utc::now().timestamp();
    let nonce = signing::new_nonce();
    let sig = signing::sign(&integration.secret, Purpose::Delivery, ts, &nonce, &body)?;
    let result = state
        .http
        .post(&url)
        .header("content-type", "application/json")
        .header(signing::HEADER_KEY_ID, &key_id)
        .header(signing::HEADER_TIMESTAMP, ts.to_string())
        .header(signing::HEADER_NONCE, &nonce)
        .header(signing::HEADER_SIGNATURE, sig)
        .header(signing::HEADER_DELIVERY_ID, event_id.to_string())
        .header(signing::HEADER_CONTENT_SHA256, &body_sha)
        .body(body)
        .send()
        .await;
    let (code, error, ack) = match result {
        Ok(res) => {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            let ack = serde_json::from_str::<DeliveryAck>(&text).ok();
            (
                Some(status.as_u16()),
                (!status.is_success()).then(|| format!("receiver returned {status}")),
                ack,
            )
        }
        Err(e) => (
            None,
            Some(format!("request error: {}", e.without_url())),
            None,
        ),
    };
    let mut tx = state.db.begin().await?;
    lease.hold(&mut tx).await?;
    sqlx::query(
        "INSERT INTO meeting_delivery_attempts (event_id, status_code, error) VALUES ($1, $2, $3)",
    )
    .bind(event_id)
    .bind(code.map(i32::from))
    .bind(&error)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE meeting_deliveries SET attempts = attempts + 1, last_status_code = $2, last_error = $3 WHERE event_id = $1",
    )
    .bind(event_id)
    .bind(code.map(i32::from))
    .bind(&error)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    match code {
        Some(c) if (200..300).contains(&c) => {
            let mut tx = state.db.begin().await?;
            lease.hold(&mut tx).await?;
            sqlx::query(
                "UPDATE meeting_deliveries SET status = 'delivered', delivered_at = now(), receipt_id = $2, ack_status = $3 WHERE event_id = $1",
            )
            .bind(event_id)
            .bind(ack.as_ref().map(|a| a.receipt_id.clone()))
            .bind(ack.as_ref().map(|a| a.status.clone()))
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            set_state(state, lease, current, Transition::Delivered).await?;
            tracing::info!(meeting = %id, event = %event_id, "delivered to Calari");
            Ok(Step::Done)
        }
        Some(408 | 429) | Some(500..=599) | None => Ok(Step::Retry(
            error.unwrap_or_else(|| "delivery failed".into()),
        )),
        Some(c) => Ok(Step::Fail(format!("receiver rejected delivery with {c}"))),
    }
}

/// Operator retry of a failed meeting (`cap-server retry-meeting <id>`).
pub async fn retry_failed(state: &AppState, id: Uuid) -> Result<()> {
    let st: Option<String> = sqlx::query_scalar("SELECT state FROM meeting_sessions WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let st = MeetingState::parse(&st.context("meeting not found")?).context("unknown state")?;
    let next = st
        .transition(Transition::Retry)
        .context("only failed meetings can be retried")?;
    sqlx::query(
        "UPDATE meeting_sessions SET state = $2, attempts = 0, next_attempt_at = now(), failure = NULL, lease_until = NULL, lease_token = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(next.as_str())
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE meeting_deliveries SET status = 'pending' WHERE meeting_id = $1 AND status = 'failed'")
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(1), Duration::seconds(30));
        assert_eq!(backoff(2), Duration::seconds(60));
        assert_eq!(backoff(4), Duration::seconds(240));
        assert_eq!(backoff(20), Duration::seconds(1_800));
    }

    #[test]
    fn prompt_tail_is_bounded() {
        let long = vec![ChunkSegment {
            start_ms: 0,
            end_ms: 1,
            text: "x".repeat(1000),
        }];
        assert_eq!(tail(&long).unwrap().len(), 200);
        assert_eq!(tail(&[]), None);
    }
}
