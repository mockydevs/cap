//! HTTP handlers for pairing and the device meeting API. See
//! `docs/integrations/calari/CONTRACT.md`.

use crate::{error::ApiError, AppState};
use axum::body::Bytes;
use axum::{
    extract::{FromRequestParts, Path, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use cap_meeting_protocol::{
    audio, ids,
    signing::{self, Purpose},
    CaptureMode, CreateMeetingRequest, CreatePairingRequest, CreatePairingResponse,
    DeliveryReceiptView, DeviceKind, FinalizeMeetingRequest, MeetingEventRequest, MeetingState,
    MeetingView, PairingKind, RedeemPairingRequest, RedeemPairingResponse, StopReason,
    DEVICE_TOKEN_TTL_SECONDS, MAX_CHUNKS, MAX_CHUNK_DURATION_MS, SCOPE_MEETING_CREATE,
    SCOPE_MEETING_UPLOAD,
};
use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

/// Failed redemptions allowed per source address per window, and overall.
const REDEEM_WINDOW_MINUTES: i64 = 10;
const REDEEM_FAILURES_PER_SOURCE: i64 = 20;
const REDEEM_FAILURES_GLOBAL: i64 = 300;

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Verifies a server-to-server request and consumes its nonce.
async fn verify_signed<'s>(
    state: &'s AppState,
    headers: &HeaderMap,
    body: &[u8],
    purpose: Purpose,
) -> Result<&'s crate::config::Integration, ApiError> {
    let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "bad_signature");
    let key_id = header(headers, signing::HEADER_KEY_ID).ok_or_else(unauthorized)?;
    let integration = state.cfg.integration(key_id).ok_or_else(unauthorized)?;
    let ts = header(headers, signing::HEADER_TIMESTAMP).ok_or_else(unauthorized)?;
    let nonce = header(headers, signing::HEADER_NONCE).ok_or_else(unauthorized)?;
    let sig = header(headers, signing::HEADER_SIGNATURE).ok_or_else(unauthorized)?;
    signing::verify(
        &integration.secret,
        purpose,
        ts,
        nonce,
        sig,
        body,
        Utc::now().timestamp(),
    )
    .map_err(|e| match e {
        signing::SignatureError::Stale => ApiError::new(StatusCode::UNAUTHORIZED, "stale_request"),
        _ => unauthorized(),
    })?;
    let inserted = sqlx::query(
        "INSERT INTO meeting_request_nonces (key_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(key_id)
    .bind(nonce)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "replayed_nonce"));
    }
    Ok(integration)
}

fn opt_uuid(v: &Option<String>) -> Option<Uuid> {
    v.as_deref().and_then(ids::parse_uuid)
}

pub async fn create_pairing(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let integration = verify_signed(&state, &headers, &body, Purpose::Pairing).await?;
    let req: CreatePairingRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "invalid_body"))?;
    req.validate()
        .map_err(|m| ApiError::new(StatusCode::BAD_REQUEST, "invalid_request").detail(m))?;
    if req.tenant_id != integration.tenant_id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "tenant_mismatch"));
    }
    let request_id = ids::parse_uuid(&req.request_id).ok_or(ApiError::bad("invalid_request"))?;
    // Canonical re-serialization so whitespace differences in a retry don't
    // look like a different request.
    let request_sha = ids::sha256_hex(&serde_json::to_vec(&req).unwrap_or_default());
    let code = signing::derive_pairing_code(&integration.secret, &request_id);
    let deep_link = |code: &str| format!("cap://pair?code={code}");

    if let Some(row) = sqlx::query(
        "SELECT id, request_sha256, expires_at, redeemed_at FROM meeting_pairings WHERE key_id = $1 AND request_id = $2",
    )
    .bind(&integration.key_id)
    .bind(request_id)
    .fetch_optional(&state.db)
    .await?
    {
        if row.get::<String, _>("request_sha256") != request_sha {
            return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
        }
        let expires_at: DateTime<Utc> = row.get("expires_at");
        let redeemed: Option<DateTime<Utc>> = row.get("redeemed_at");
        if redeemed.is_some() || expires_at <= Utc::now() {
            return Err(ApiError::new(StatusCode::GONE, "pairing_unavailable"));
        }
        let id: Uuid = row.get("id");
        return Ok((
            StatusCode::OK,
            Json(CreatePairingResponse {
                pairing_id: id.to_string(),
                deep_link: deep_link(&code),
                code,
                expires_at,
            }),
        ));
    }

    let id = ids::new_id();
    // Whole seconds, so a retried request reads back exactly the same value.
    let expires_at = (Utc::now() + Duration::seconds(i64::from(req.ttl_seconds))).trunc_subsecs(0);
    let normalized = ids::normalize_pairing_code(&code).ok_or(ApiError::internal())?;
    let display = req
        .client_display_name
        .as_deref()
        .and_then(|n| cap_meeting_protocol::clean_text(n, 120));
    let inserted = sqlx::query(
        "INSERT INTO meeting_pairings (id, key_id, request_id, request_sha256, tenant_id, pairing_kind, client_id, intake_receipt_id, client_display_name, code_hash, expires_at, pkce_challenge)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (key_id, request_id) DO NOTHING",
    )
    .bind(id)
    .bind(&integration.key_id)
    .bind(request_id)
    .bind(&request_sha)
    .bind(&integration.tenant_id)
    .bind(req.pairing_kind.as_str())
    .bind(opt_uuid(&req.client_id))
    .bind(opt_uuid(&req.intake_receipt_id))
    .bind(display)
    .bind(ids::sha256_hex(normalized.as_bytes()))
    .bind(expires_at)
    .bind(&req.pkce_challenge)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        // A concurrent identical request won the race; it will be answered
        // on the caller's next retry.
        return Err(ApiError::new(StatusCode::CONFLICT, "request_in_progress"));
    }
    tracing::info!(pairing_id = %id, kind = req.pairing_kind.as_str(), "pairing created");
    Ok((
        StatusCode::CREATED,
        Json(CreatePairingResponse {
            pairing_id: id.to_string(),
            deep_link: deep_link(&code),
            code,
            expires_at,
        }),
    ))
}

/// The address a request came from, honouring only the configured number of
/// trusted proxies.
pub struct ClientSource(pub String);

impl FromRequestParts<AppState> for ClientSource {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        let hops = state.cfg.trusted_proxy_hops;
        if hops == 0 {
            return Ok(Self(peer));
        }
        let forwarded: Vec<&str> = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').map(str::trim).collect())
            .unwrap_or_default();
        // The right-most `hops` entries were added by our own proxies.
        let pick = forwarded
            .len()
            .checked_sub(hops)
            .and_then(|i| forwarded.get(i));
        Ok(Self(pick.map(|s| (*s).to_owned()).unwrap_or(peer)))
    }
}

pub async fn redeem_pairing(
    State(state): State<AppState>,
    ClientSource(source): ClientSource,
    Json(req): Json<RedeemPairingRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let window = Utc::now() - Duration::minutes(REDEEM_WINDOW_MINUTES);
    let row = sqlx::query(
        "SELECT count(*) FILTER (WHERE source = $1) AS mine, count(*) AS total FROM meeting_redeem_failures WHERE at > $2",
    )
    .bind(&source)
    .bind(window)
    .fetch_one(&state.db)
    .await?;
    if row.get::<i64, _>("mine") >= REDEEM_FAILURES_PER_SOURCE
        || row.get::<i64, _>("total") >= REDEEM_FAILURES_GLOBAL
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
        ));
    }
    let device_name = cap_meeting_protocol::clean_text(&req.device_name, 80)
        .ok_or(ApiError::bad("invalid_device_name"))?;
    // Calendar bot devices are issued by the server itself, never redeemed
    // over the public endpoint.
    if req.device_kind == DeviceKind::CalendarBot {
        return Err(ApiError::bad("invalid_device_kind"));
    }

    let fail = || async {
        sqlx::query("INSERT INTO meeting_redeem_failures (source) VALUES ($1)")
            .bind(&source)
            .execute(&state.db)
            .await?;
        Ok::<_, ApiError>(ApiError::new(StatusCode::NOT_FOUND, "pairing_invalid"))
    };
    let Some(code) = ids::normalize_pairing_code(&req.code) else {
        return Err(fail().await?);
    };
    let now = Utc::now();
    let mut tx = state.db.begin().await?;
    let Some(p) = sqlx::query(
        "UPDATE meeting_pairings SET redeemed_at = $2
         WHERE code_hash = $1 AND redeemed_at IS NULL AND expires_at > $2
           AND (pkce_challenge IS NULL OR pkce_challenge = $3)
         RETURNING id, tenant_id, pairing_kind, client_id, client_display_name",
    )
    .bind(ids::sha256_hex(code.as_bytes()))
    .bind(now)
    // A pairing from "Sign in with Calari" needs its PKCE verifier; a wrong
    // or missing one looks exactly like a wrong code.
    .bind(
        req.code_verifier
            .as_deref()
            .filter(|v| cap_meeting_protocol::valid_pkce_verifier(v))
            .map(cap_meeting_protocol::pkce_s256),
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        drop(tx);
        return Err(fail().await?);
    };
    let token = ids::new_device_token();
    let expires_at = (now + Duration::seconds(DEVICE_TOKEN_TTL_SECONDS)).trunc_subsecs(0);
    sqlx::query(
        "INSERT INTO meeting_devices (token_hash, pairing_id, device_name, device_kind, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(ids::sha256_hex(token.as_bytes()))
    .bind(p.get::<Uuid, _>("id"))
    .bind(&device_name)
    .bind(req.device_kind.as_str())
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let kind = PairingKind::parse(p.get("pairing_kind")).ok_or(ApiError::internal())?;
    Ok(Json(RedeemPairingResponse {
        device_token: token,
        tenant_id: p.get("tenant_id"),
        pairing_kind: kind,
        client_id: p.get::<Option<Uuid>, _>("client_id").map(|u| u.to_string()),
        client_display_name: p.get("client_display_name"),
        expires_at,
        scopes: vec![SCOPE_MEETING_CREATE.into(), SCOPE_MEETING_UPLOAD.into()],
    }))
}

/// An authenticated, unexpired device token.
pub struct Device {
    pub token_hash: String,
    pub pairing_id: Uuid,
    pub kind: DeviceKind,
}

impl FromRequestParts<AppState> for Device {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized");
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| t.starts_with("capdev_") && t.len() == 71)
            .ok_or_else(unauthorized)?;
        let hash = ids::sha256_hex(token.as_bytes());
        let row = sqlx::query(
            "SELECT pairing_id, device_kind FROM meeting_devices WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL",
        )
        .bind(&hash)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(unauthorized)?;
        let kind = DeviceKind::parse(&row.get::<String, _>("device_kind"))
            .unwrap_or(DeviceKind::Extension);
        Ok(Device {
            token_hash: hash,
            pairing_id: row.get("pairing_id"),
            kind,
        })
    }
}

/// Builds the device-facing view. Only finds meetings this token created.
async fn view(state: &AppState, device: &Device, id: Uuid) -> Result<MeetingView, ApiError> {
    let m = sqlx::query(
        "SELECT m.id, m.title, m.state, m.capture_mode, m.stop_reason, m.failure, m.last_seq, p.pairing_kind, p.client_id
         FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         WHERE m.id = $1 AND m.device_token_hash = $2",
    )
    .bind(id)
    .bind(&device.token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "meeting_not_found"))?;
    let seqs: Vec<i32> =
        sqlx::query_scalar("SELECT seq FROM meeting_chunks WHERE meeting_id = $1 ORDER BY seq")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    let last: Option<i32> = m.get("last_seq");
    let max_seen = seqs.last().copied();
    let upper = last.or(max_seen);
    let missing = upper
        .map(|u| {
            (0..=u)
                .filter(|s| seqs.binary_search(s).is_err())
                .map(|s| s as u32)
                .collect()
        })
        .unwrap_or_default();
    let delivery = sqlx::query(
        "SELECT event_id, status, attempts, receipt_id FROM meeting_deliveries WHERE meeting_id = $1 ORDER BY revision DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .map(|d| DeliveryReceiptView {
        event_id: d.get::<Uuid, _>("event_id").to_string(),
        status: d.get("status"),
        attempts: d.get::<i32, _>("attempts").max(0) as u32,
        receipt_id: d.get("receipt_id"),
    });
    Ok(MeetingView {
        id: id.to_string(),
        pairing_kind: PairingKind::parse(m.get("pairing_kind")).ok_or(ApiError::internal())?,
        capture_mode: CaptureMode::parse(m.get("capture_mode")).ok_or(ApiError::internal())?,
        client_id: m.get::<Option<Uuid>, _>("client_id").map(|u| u.to_string()),
        title: m.get("title"),
        state: MeetingState::parse(m.get("state")).ok_or(ApiError::internal())?,
        received_chunks: seqs.len() as u32,
        missing_chunks: missing,
        stop_reason: m
            .get::<Option<String>, _>("stop_reason")
            .and_then(|s| StopReason::parse(&s)),
        delivery,
        failure: m.get("failure"),
    })
}

pub async fn create_meeting(
    State(state): State<AppState>,
    device: Device,
    Json(req): Json<CreateMeetingRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let title =
        cap_meeting_protocol::clean_text(&req.title, 200).ok_or(ApiError::bad("invalid_title"))?;
    if !cap_meeting_protocol::valid_external_id(&req.idempotency_key) {
        return Err(ApiError::bad("invalid_idempotency_key"));
    }
    let now = Utc::now();
    if req.started_at > now + Duration::minutes(5) || req.started_at < now - Duration::days(2) {
        return Err(ApiError::bad("invalid_started_at"));
    }
    let sanitized = req
        .meeting_url
        .as_deref()
        .and_then(cap_meeting_protocol::sanitize_meeting_url);
    let provider_hint = sanitized
        .as_ref()
        .map(|(_, p)| (*p).to_owned())
        .or_else(|| {
            req.provider_hint
                .as_deref()
                .filter(|h| h.len() <= 64 && cap_meeting_protocol::valid_external_id(h))
                .map(str::to_owned)
        });
    let id = ids::new_id();
    let inserted = sqlx::query(
        "INSERT INTO meeting_sessions (id, pairing_id, device_token_hash, idempotency_key, title, capture_mode, provider_hint, meeting_url, source, started_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'recording')
         ON CONFLICT (device_token_hash, idempotency_key) DO NOTHING",
    )
    .bind(id)
    .bind(device.pairing_id)
    .bind(&device.token_hash)
    .bind(&req.idempotency_key)
    .bind(&title)
    .bind(req.capture_mode.as_str())
    .bind(provider_hint)
    .bind(sanitized.map(|(u, _)| u))
    .bind(device.kind.as_str())
    .bind(req.started_at)
    .execute(&state.db)
    .await?
    .rows_affected();
    let (status, id) = if inserted == 1 {
        (StatusCode::CREATED, id)
    } else {
        let existing: Uuid = sqlx::query_scalar(
            "SELECT id FROM meeting_sessions WHERE device_token_hash = $1 AND idempotency_key = $2",
        )
        .bind(&device.token_hash)
        .bind(&req.idempotency_key)
        .fetch_one(&state.db)
        .await?;
        (StatusCode::OK, existing)
    };
    Ok((status, Json(view(&state, &device, id).await?)))
}

pub async fn get_meeting(
    State(state): State<AppState>,
    device: Device,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(view(&state, &device, id).await?))
}

fn parse_header_u64(headers: &HeaderMap, name: &str) -> Result<u64, ApiError> {
    header(headers, name)
        .and_then(|v| v.parse().ok())
        .ok_or(ApiError::bad("invalid_chunk_headers"))
}

pub async fn put_chunk(
    State(state): State<AppState>,
    device: Device,
    Path((id, seq)): Path<(Uuid, u32)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    if seq >= MAX_CHUNKS {
        return Err(ApiError::bad("seq_out_of_range"));
    }
    let m = sqlx::query(
        "SELECT state, capture_mode, p.tenant_id FROM meeting_sessions m JOIN meeting_pairings p ON p.id = m.pairing_id
         WHERE m.id = $1 AND m.device_token_hash = $2",
    )
    .bind(id)
    .bind(&device.token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "meeting_not_found"))?;
    let mode = CaptureMode::parse(m.get("capture_mode")).ok_or(ApiError::internal())?;
    let claimed = header(&headers, "x-chunk-sha256")
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or(ApiError::bad("invalid_chunk_headers"))?
        .to_ascii_lowercase();
    let start_ms = parse_header_u64(&headers, "x-chunk-start-ms")?;
    let duration_ms = parse_header_u64(&headers, "x-chunk-duration-ms")?;
    if duration_ms == 0 || duration_ms > MAX_CHUNK_DURATION_MS || start_ms > 24 * 3_600_000 {
        return Err(ApiError::bad("invalid_chunk_headers"));
    }
    if body.is_empty() || body.len() > mode.max_chunk_bytes() {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "chunk_size"));
    }
    let container = audio::sniff(&body)
        .ok_or_else(|| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media"))?;
    let actual = ids::sha256_hex(&body);
    if actual != claimed {
        return Err(ApiError::bad("checksum_mismatch"));
    }
    if let Some(existing) = sqlx::query_scalar::<_, String>(
        "SELECT sha256 FROM meeting_chunks WHERE meeting_id = $1 AND seq = $2",
    )
    .bind(id)
    .bind(seq as i32)
    .fetch_optional(&state.db)
    .await?
    {
        return if existing == actual {
            Ok((StatusCode::OK, Json(json!({"status": "duplicate"}))))
        } else {
            Err(ApiError::new(StatusCode::CONFLICT, "chunk_conflict"))
        };
    }
    if !MeetingState::parse(m.get("state")).is_some_and(MeetingState::accepts_chunks) {
        return Err(ApiError::new(StatusCode::CONFLICT, "meeting_not_recording"));
    }
    // The key contains the content hash, so a racing upload of different
    // bytes for the same seq can never overwrite stored audio.
    let tenant: String = m.get("tenant_id");
    let key = format!(
        "meetings/{tenant}/{id}/{seq:06}-{}.{}",
        &actual[..16],
        container.extension()
    );
    state
        .store
        .put(&key, body.to_vec(), container.mime())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "storing chunk failed");
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable")
        })?;
    // Re-check under the meeting row lock that finalize and the abandon
    // sweep also take: if the meeting stopped accepting audio while the
    // object was being stored, the chunk is refused rather than silently
    // missing from the transcript.
    let mut tx = state.db.begin().await?;
    let current: String = sqlx::query_scalar(
        "SELECT state FROM meeting_sessions WHERE id = $1 AND device_token_hash = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(&device.token_hash)
    .fetch_one(&mut *tx)
    .await?;
    if !MeetingState::parse(&current).is_some_and(MeetingState::accepts_chunks) {
        tx.rollback().await?;
        return Err(ApiError::new(StatusCode::CONFLICT, "meeting_not_recording"));
    }
    let inserted = sqlx::query(
        "INSERT INTO meeting_chunks (meeting_id, seq, sha256, size_bytes, container, object_key, start_ms, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(seq as i32)
    .bind(&actual)
    .bind(body.len() as i64)
    .bind(container.extension())
    .bind(&key)
    .bind(start_ms as i64)
    .bind(duration_ms as i64)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "UPDATE meeting_sessions SET last_upload_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if inserted == 0 {
        // Lost a race with an upload of the same seq; report what won.
        let winner: String = sqlx::query_scalar(
            "SELECT sha256 FROM meeting_chunks WHERE meeting_id = $1 AND seq = $2",
        )
        .bind(id)
        .bind(seq as i32)
        .fetch_one(&state.db)
        .await?;
        return if winner == actual {
            Ok((StatusCode::OK, Json(json!({"status": "duplicate"}))))
        } else {
            Err(ApiError::new(StatusCode::CONFLICT, "chunk_conflict"))
        };
    }
    Ok((StatusCode::CREATED, Json(json!({"status": "stored"}))))
}

pub async fn finalize_meeting(
    State(state): State<AppState>,
    device: Device,
    Path(id): Path<Uuid>,
    Json(req): Json<FinalizeMeetingRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if req.last_seq >= MAX_CHUNKS {
        return Err(ApiError::bad("seq_out_of_range"));
    }
    if req.stop_reason == StopReason::Interrupted && !req.allow_missing {
        // Interrupted recordings are expected to have gaps; say so explicitly.
        tracing::debug!(meeting = %id, "interrupted finalize without allow_missing");
    }
    let mut tx = state.db.begin().await?;
    let m = sqlx::query(
        "SELECT state, last_seq, started_at FROM meeting_sessions WHERE id = $1 AND device_token_hash = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(&device.token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "meeting_not_found"))?;
    let current = MeetingState::parse(m.get("state")).ok_or(ApiError::internal())?;
    if current != MeetingState::Recording {
        drop(tx);
        // Idempotent: a repeated finalize for the same end point is fine.
        return if m.get::<Option<i32>, _>("last_seq") == Some(req.last_seq as i32) {
            Ok((StatusCode::ACCEPTED, Json(view(&state, &device, id).await?)))
        } else {
            Err(ApiError::new(StatusCode::CONFLICT, "already_finalized"))
        };
    }
    let started: DateTime<Utc> = m.get("started_at");
    if req.ended_at < started || req.ended_at > Utc::now() + Duration::minutes(5) {
        return Err(ApiError::bad("invalid_ended_at"));
    }
    let seqs: Vec<i32> =
        sqlx::query_scalar("SELECT seq FROM meeting_chunks WHERE meeting_id = $1 ORDER BY seq")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    if seqs.last().is_some_and(|&s| s > req.last_seq as i32) {
        return Err(ApiError::bad("chunks_after_last_seq"));
    }
    let missing: Vec<u32> = (0..=req.last_seq as i32)
        .filter(|s| seqs.binary_search(s).is_err())
        .map(|s| s as u32)
        .collect();
    if seqs.is_empty() {
        return Err(ApiError::new(StatusCode::CONFLICT, "no_audio").missing(missing));
    }
    if !missing.is_empty() && !req.allow_missing {
        return Err(ApiError::new(StatusCode::CONFLICT, "missing_chunks").missing(missing));
    }
    let next = current
        .transition(cap_meeting_protocol::Transition::Finalize)
        .ok_or(ApiError::internal())?;
    sqlx::query(
        "UPDATE meeting_sessions SET state = $2, last_seq = $3, stop_reason = $4, ended_at = $5, partial = $6,
         next_attempt_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(next.as_str())
    .bind(req.last_seq as i32)
    .bind(req.stop_reason.as_str())
    .bind(req.ended_at)
    .bind(!missing.is_empty() || req.stop_reason == StopReason::Interrupted)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    state.wake_worker();
    Ok((StatusCode::ACCEPTED, Json(view(&state, &device, id).await?)))
}

pub async fn meeting_event(
    State(state): State<AppState>,
    device: Device,
    Path(id): Path<Uuid>,
    Json(req): Json<MeetingEventRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let detail = match req.detail.as_deref() {
        Some(d) => {
            Some(cap_meeting_protocol::clean_text(d, 500).ok_or(ApiError::bad("invalid_detail"))?)
        }
        None => None,
    };
    let kind = serde_json::to_value(req.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or(ApiError::internal())?;
    let inserted = sqlx::query(
        "INSERT INTO meeting_events (meeting_id, kind, at, detail)
         SELECT id, $3, $4, $5 FROM meeting_sessions WHERE id = $1 AND device_token_hash = $2",
    )
    .bind(id)
    .bind(&device.token_hash)
    .bind(kind)
    .bind(req.at)
    .bind(detail)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "meeting_not_found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Lets a new pairing finish a meeting whose original device credential has
/// expired or been revoked (for example Clare re-paired after the 12-hour
/// token ran out mid-upload). Only a pairing for the same tenant, the same
/// kind and the same client may take over, and only while the meeting still
/// accepts audio. The meeting keeps its original pairing, so the delivery
/// is still bound to the client and receipt Calari authorised.
pub async fn adopt_meeting(
    State(state): State<AppState>,
    device: Device,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "meeting_not_found");
    let mut tx = state.db.begin().await?;
    let m = sqlx::query(
        "SELECT m.state, m.device_token_hash, p.tenant_id, p.pairing_kind, p.client_id,
                (d.revoked_at IS NULL AND d.expires_at > now()) AS owner_active
         FROM meeting_sessions m
         JOIN meeting_pairings p ON p.id = m.pairing_id
         JOIN meeting_devices d ON d.token_hash = m.device_token_hash
         WHERE m.id = $1 FOR UPDATE OF m",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(not_found)?;
    let mine = sqlx::query(
        "SELECT tenant_id, pairing_kind, client_id FROM meeting_pairings WHERE id = $1",
    )
    .bind(device.pairing_id)
    .fetch_one(&mut *tx)
    .await?;
    let same_binding = m.get::<String, _>("tenant_id") == mine.get::<String, _>("tenant_id")
        && m.get::<String, _>("pairing_kind") == mine.get::<String, _>("pairing_kind")
        && m.get::<Option<Uuid>, _>("client_id") == mine.get::<Option<Uuid>, _>("client_id");
    if !same_binding {
        // Indistinguishable from a meeting that does not exist.
        return Err(not_found());
    }
    if m.get::<String, _>("device_token_hash") != device.token_hash {
        if m.get::<bool, _>("owner_active") {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "meeting_owned_by_active_device",
            ));
        }
        if !MeetingState::parse(m.get("state")).is_some_and(MeetingState::accepts_chunks) {
            return Err(ApiError::new(StatusCode::CONFLICT, "meeting_not_recording"));
        }
        sqlx::query(
            "UPDATE meeting_sessions SET device_token_hash = $2, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&device.token_hash)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO meeting_events (meeting_id, kind, at, detail) VALUES ($1, 'adopted', now(), $2)")
            .bind(id)
            .bind(format!("taken over by a re-paired {} device", device.kind.as_str()))
            .execute(&mut *tx)
            .await?;
        tracing::info!(meeting = %id, "meeting adopted by re-paired device");
    }
    tx.commit().await?;
    Ok(Json(view(&state, &device, id).await?))
}
