//! Signed Cap → Calari calls for calendar attendance (purpose `calendar`).
//! Calari owns staff, clients and access: Cap asks, never assumes.

use crate::{config::Integration, AppState};
use cap_meeting_protocol::{
    signing::{self, Purpose},
    CalendarPairingRequest, CalendarPairingResponse, CalendarResolveRequest,
    CalendarResolveResponse, MAX_CALENDAR_ATTENDEES,
};
use chrono::Utc;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CalariError {
    /// Calari refused (staff inactive, client not accessible).
    #[error("Calari refused the calendar request")]
    Refused,
    #[error("Calari is not reachable or answered unexpectedly")]
    Retry,
    #[error("calendar is not configured for this tenant")]
    NotConfigured,
}

pub fn integration<'a>(state: &'a AppState, tenant_id: &str) -> Option<&'a Integration> {
    state
        .cfg
        .integration_for_tenant(tenant_id)
        .filter(|i| i.calendar_pairing_url.is_some() && i.calendar_resolve_url.is_some())
}

async fn signed_post<T: serde::de::DeserializeOwned>(
    state: &AppState,
    integration: &Integration,
    url: &str,
    body: Vec<u8>,
) -> Result<T, CalariError> {
    let ts = Utc::now().timestamp();
    let nonce = signing::new_nonce();
    let sig = signing::sign(&integration.secret, Purpose::Calendar, ts, &nonce, &body)
        .map_err(|_| CalariError::Retry)?;
    let res = state
        .http
        .post(url)
        .header("content-type", "application/json")
        .header(signing::HEADER_KEY_ID, &integration.key_id)
        .header(signing::HEADER_TIMESTAMP, ts.to_string())
        .header(signing::HEADER_NONCE, &nonce)
        .header(signing::HEADER_SIGNATURE, sig)
        .body(body)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e.without_url(), "Calari calendar endpoint unreachable");
            CalariError::Retry
        })?;
    match res.status().as_u16() {
        200 | 201 => {}
        401 | 403 | 404 | 409 | 422 => return Err(CalariError::Refused),
        code => {
            tracing::warn!(status = code, "Calari calendar endpoint failed");
            return Err(CalariError::Retry);
        }
    }
    let mut res = res;
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| CalariError::Retry)? {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err(CalariError::Retry);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CalariError::Retry)
}

/// Staff status plus verified attendee→client mappings, restricted by Calari
/// to clients this staff member may access.
pub async fn resolve(
    state: &AppState,
    tenant_id: &str,
    user_id: &str,
    emails: &[String],
) -> Result<CalendarResolveResponse, CalariError> {
    let integration = integration(state, tenant_id).ok_or(CalariError::NotConfigured)?;
    let url = integration
        .calendar_resolve_url
        .as_deref()
        .ok_or(CalariError::NotConfigured)?;
    let mut merged: Option<CalendarResolveResponse> = None;
    // At least one call, even with no attendees: it is also the status check.
    let chunks: Vec<&[String]> = if emails.is_empty() {
        vec![&[]]
    } else {
        emails.chunks(MAX_CALENDAR_ATTENDEES).collect()
    };
    for chunk in chunks {
        let body = serde_json::to_vec(&CalendarResolveRequest {
            user_id: user_id.to_owned(),
            attendee_emails: chunk.to_vec(),
        })
        .map_err(|_| CalariError::Retry)?;
        let r: CalendarResolveResponse = signed_post(state, integration, url, body).await?;
        if r.tenant_id != tenant_id || r.user_id != user_id {
            return Err(CalariError::Refused);
        }
        // Only mappings for emails we asked about count.
        let asked: std::collections::BTreeSet<&str> = chunk.iter().map(String::as_str).collect();
        let mut r = r;
        r.mappings.retain(|m| {
            asked.contains(m.email.trim().to_lowercase().as_str())
                && cap_meeting_protocol::ids::parse_uuid(&m.client_id).is_some()
        });
        merged = Some(match merged {
            None => r,
            Some(mut acc) => {
                acc.active &= r.active;
                acc.mappings.extend(r.mappings);
                acc
            }
        });
    }
    merged.ok_or(CalariError::Retry)
}

pub async fn request_pairing(
    state: &AppState,
    tenant_id: &str,
    req: &CalendarPairingRequest,
) -> Result<CalendarPairingResponse, CalariError> {
    let integration = integration(state, tenant_id).ok_or(CalariError::NotConfigured)?;
    let url = integration
        .calendar_pairing_url
        .as_deref()
        .ok_or(CalariError::NotConfigured)?;
    let body = serde_json::to_vec(req).map_err(|_| CalariError::Retry)?;
    signed_post(state, integration, url, body).await
}
