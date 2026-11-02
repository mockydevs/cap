//! Wire types for the Calari integration and the device-facing meeting API.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const DELIVERY_SCHEMA: &str = "cap.meeting.delivery.v1";
pub const EVENT_TRANSCRIPT_COMPLETED: &str = "meeting.transcript.completed";
pub const SCOPE_MEETING_CREATE: &str = "meeting:create";
pub const SCOPE_MEETING_UPLOAD: &str = "meeting:upload";

pub const PAIRING_TTL_MIN_SECONDS: u32 = 60;
pub const PAIRING_TTL_MAX_SECONDS: u32 = 900;
pub const DEVICE_TOKEN_TTL_SECONDS: i64 = 12 * 3600;
pub const MAX_AUDIO_CHUNK_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_VIDEO_CHUNK_BYTES: usize = 48 * 1024 * 1024;
pub const MAX_CHUNK_DURATION_MS: u64 = 10 * 60_000;
pub const MAX_CHUNKS: u32 = 2_000;

/// Identifier shape accepted from Calari: 1-128 chars of `[A-Za-z0-9_.:-]`.
pub fn valid_external_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

/// Free text from a client: trimmed, 1..=max chars, no control characters.
pub fn clean_text(input: &str, max: usize) -> Option<String> {
    let trimmed = input.trim();
    let ok = !trimmed.is_empty()
        && trimmed.chars().count() <= max
        && !trimmed.chars().any(char::is_control);
    ok.then(|| trimmed.to_owned())
}

/// Who the meeting is with, as Calari authorised it when issuing the pairing.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingKind {
    /// Issued from a just-completed /intake receipt for that new client.
    ClientIntake,
    /// Issued by staff from an existing client's page.
    StaffClient,
    /// Internal meeting (for example Clare briefing or delegating to staff);
    /// no client is attached.
    InternalTeam,
}

impl PairingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PairingKind::ClientIntake => "client_intake",
            PairingKind::StaffClient => "staff_client",
            PairingKind::InternalTeam => "internal_team",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CreatePairingRequest {
    /// Stable per logical request; retrying with the same id and body
    /// returns the same pairing and code.
    pub request_id: String,
    pub tenant_id: String,
    pub pairing_kind: PairingKind,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub intake_receipt_id: Option<String>,
    #[serde(default)]
    pub client_display_name: Option<String>,
    pub ttl_seconds: u32,
    /// Set when the pairing comes from the extension's "Sign in with
    /// Calari" flow: `base64url(sha256(code_verifier))`. The code then only
    /// redeems together with the verifier, so a code seen in transit is
    /// useless on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pkce_challenge: Option<String>,
    /// Must be "S256" when `pkce_challenge` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pkce_method: Option<String>,
}

impl CreatePairingRequest {
    /// Shape rules that do not need the database.
    pub fn validate(&self) -> Result<(), &'static str> {
        let uuid = |v: &Option<String>| v.as_deref().map(|s| crate::ids::parse_uuid(s).is_some());
        if crate::ids::parse_uuid(&self.request_id).is_none() {
            return Err("request_id must be a UUID");
        }
        if !valid_external_id(&self.tenant_id) {
            return Err("invalid tenant_id");
        }
        if !(PAIRING_TTL_MIN_SECONDS..=PAIRING_TTL_MAX_SECONDS).contains(&self.ttl_seconds) {
            return Err("ttl_seconds must be 60-900");
        }
        match (&self.pkce_challenge, self.pkce_method.as_deref()) {
            (None, None) => {}
            (Some(c), Some("S256")) if valid_pkce_challenge(c) => {}
            _ => {
                return Err("pkce_challenge must be 43 base64url characters with pkce_method S256")
            }
        }
        if let Some(name) = &self.client_display_name {
            if clean_text(name, 120).is_none() {
                return Err("invalid client_display_name");
            }
        }
        match self.pairing_kind {
            PairingKind::ClientIntake => {
                if uuid(&self.client_id) != Some(true)
                    || uuid(&self.intake_receipt_id) != Some(true)
                {
                    return Err("client_intake needs client_id and intake_receipt_id UUIDs");
                }
            }
            PairingKind::StaffClient => {
                if uuid(&self.client_id) != Some(true)
                    || uuid(&self.intake_receipt_id) == Some(false)
                {
                    return Err("staff_client needs a client_id UUID");
                }
            }
            PairingKind::InternalTeam => {
                if self.client_id.is_some() || self.intake_receipt_id.is_some() {
                    return Err("internal_team must not name a client or receipt");
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CreatePairingResponse {
    pub pairing_id: String,
    pub code: String,
    pub expires_at: DateTime<Utc>,
    pub deep_link: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Desktop,
    Extension,
    /// Cap's own server-side calendar attendance worker. Never accepted from
    /// the public pairing redeem endpoint; the server issues it internally.
    CalendarBot,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Desktop => "desktop",
            DeviceKind::Extension => "extension",
            DeviceKind::CalendarBot => "calendar_bot",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "desktop" => Some(Self::Desktop),
            "extension" => Some(Self::Extension),
            "calendar_bot" => Some(Self::CalendarBot),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RedeemPairingRequest {
    pub code: String,
    pub device_name: String,
    pub device_kind: DeviceKind,
    /// The PKCE verifier, for pairings created with a challenge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
}

/// RFC 7636 S256 challenge for a verifier.
pub fn pkce_s256(verifier: &str) -> String {
    use base64::Engine;
    use sha2::Digest;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()))
}

/// RFC 7636 verifier: 43-128 characters of `[A-Za-z0-9-._~]`.
pub fn valid_pkce_verifier(v: &str) -> bool {
    (43..=128).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

pub fn valid_pkce_challenge(c: &str) -> bool {
    c.len() == 43
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RedeemPairingResponse {
    pub device_token: String,
    pub tenant_id: String,
    pub pairing_kind: PairingKind,
    pub client_id: Option<String>,
    pub client_display_name: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub scopes: Vec<String>,
}

/// What the device records. Both modes are transcribed; video also keeps the
/// picture for playback in Cap.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    #[default]
    Audio,
    Video,
}

impl CaptureMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureMode::Audio => "audio",
            CaptureMode::Video => "video",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
    }

    pub fn max_chunk_bytes(self) -> usize {
        match self {
            CaptureMode::Audio => MAX_AUDIO_CHUNK_BYTES,
            CaptureMode::Video => MAX_VIDEO_CHUNK_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CreateMeetingRequest {
    pub title: String,
    pub idempotency_key: String,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub capture_mode: CaptureMode,
    #[serde(default)]
    pub provider_hint: Option<String>,
    /// The meeting page the extension captured, if any. Only https URLs on
    /// known meeting hosts are kept; anything else is dropped.
    #[serde(default)]
    pub meeting_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserStopped,
    MeetingEnded,
    TabClosed,
    WindowClosed,
    DeviceLost,
    ProlongedInactivity,
    HardLimit,
    Interrupted,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::UserStopped => "user_stopped",
            StopReason::MeetingEnded => "meeting_ended",
            StopReason::TabClosed => "tab_closed",
            StopReason::WindowClosed => "window_closed",
            StopReason::DeviceLost => "device_lost",
            StopReason::ProlongedInactivity => "prolonged_inactivity",
            StopReason::HardLimit => "hard_limit",
            StopReason::Interrupted => "interrupted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).ok()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FinalizeMeetingRequest {
    pub last_seq: u32,
    pub stop_reason: StopReason,
    pub ended_at: DateTime<Utc>,
    /// Finalize even though some chunks never arrived (for example the
    /// device lost them in a crash). The delivery is marked `partial`.
    #[serde(default)]
    pub allow_missing: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingEventKind {
    IdleWarning,
    KeepRecording,
    Paused,
    Resumed,
    SignalReceived,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeetingEventRequest {
    pub kind: MeetingEventKind,
    pub at: DateTime<Utc>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MeetingView {
    pub id: String,
    pub pairing_kind: PairingKind,
    pub capture_mode: CaptureMode,
    pub client_id: Option<String>,
    pub title: String,
    pub state: crate::MeetingState,
    pub received_chunks: u32,
    pub missing_chunks: Vec<u32>,
    pub stop_reason: Option<StopReason>,
    pub delivery: Option<DeliveryReceiptView>,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryReceiptView {
    pub event_id: String,
    pub status: String,
    pub attempts: u32,
    pub receipt_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ApiError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_chunks: Option<Vec<u32>>,
}

// ---- Library sign-in (Cap → Calari, signed purpose `login`) ----

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoginExchangeRequest {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StaffRole {
    Admin,
    Staff,
    /// Calari's status answer for someone who may not use Cap.
    None,
}

/// The Calari staff member a sign-in code belongs to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LoginExchangeResponse {
    pub tenant_id: String,
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub role: StaffRole,
}

/// Cap asks whether a signed-in staff member may still use Cap.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoginStatusRequest {
    pub user_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LoginStatusResponse {
    pub tenant_id: String,
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub role: StaffRole,
    pub active: bool,
}

// ---- Delivery (Cap → Calari) ----

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryPayload {
    pub schema: String,
    pub event_id: String,
    pub event_type: String,
    pub revision: u32,
    pub tenant_id: String,
    /// `None` for `internal_team` meetings.
    pub client_id: Option<String>,
    pub pairing_id: String,
    pub intake_receipt_id: Option<String>,
    pub context: DeliveryContext,
    pub meeting: DeliveredMeeting,
    pub transcript: DeliveredTranscript,
    pub summary: Option<DeliveredSummary>,
    pub created_at: DateTime<Utc>,
}

/// Facts Cap knows for certain, to help Calari classify the meeting (client
/// meeting versus internal briefing or delegation). Cap does not guess.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryContext {
    pub pairing_kind: PairingKind,
    pub capture_mode: CaptureMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveredMeeting {
    pub id: String,
    pub title: String,
    pub source: DeviceKind,
    pub provider_hint: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub duration_ms: u64,
    pub stop_reason: StopReason,
    /// Partial audio was finalized after an interruption or missing chunks.
    pub partial: bool,
    /// A page in Cap where a signed-in person can view the meeting. `None`
    /// until Cap has a meeting viewer (ADR 0004 phase 4); never an API route.
    pub cap_url: Option<String>,
    pub meeting_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveredTranscript {
    pub provider: String,
    pub model: String,
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
    pub text: String,
    /// Opaque content identifier for duplicate detection.
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TranscriptSegment {
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveredSummary {
    pub provider: String,
    pub model: String,
    pub text: String,
    pub action_items: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeliveryAck {
    pub receipt_id: String,
    pub status: String,
}

/// Namespace for delivery event ids (UUID v5).
const EVENT_NAMESPACE: uuid::Uuid = uuid::Uuid::from_bytes([
    0x6c, 0x2b, 0x3e, 0x51, 0x8a, 0x0d, 0x4f, 0x1e, 0x9b, 0x77, 0x20, 0x43, 0xc1, 0x5e, 0x9a, 0x02,
]);

/// Stable event id for one meeting revision, so a retried or re-sent
/// delivery is recognisably the same event.
pub fn delivery_event_id(meeting_id: &str, revision: u32) -> String {
    uuid::Uuid::new_v5(
        &EVENT_NAMESPACE,
        format!("{meeting_id}:{revision}").as_bytes(),
    )
    .to_string()
}

pub fn transcript_digest(segments: &[TranscriptSegment]) -> String {
    let bytes = serde_json::to_vec(segments).unwrap_or_default();
    crate::ids::sha256_hex(&bytes)
}

/// Hosts whose meeting page URL we are willing to forward to Calari.
pub const MEETING_HOSTS: &[(&str, &str)] = &[
    ("meet.google.com", "google_meet"),
    ("zoom.us", "zoom"),
    ("app.zoom.us", "zoom"),
    ("teams.microsoft.com", "microsoft_teams"),
    ("teams.live.com", "microsoft_teams"),
    ("webex.com", "webex"),
    ("whereby.com", "whereby"),
];

/// Returns `(sanitized url, provider)` for an https URL on a known meeting
/// host (or a subdomain of one). Query string and fragment are dropped
/// because they can carry passcodes.
pub fn sanitize_meeting_url(raw: &str) -> Option<(String, &'static str)> {
    let rest = raw.trim().strip_prefix("https://")?;
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if host_port.contains(['@', ':']) {
        return None;
    }
    let host = host_port.to_ascii_lowercase();
    let provider = MEETING_HOSTS.iter().find_map(|(known, provider)| {
        (host == *known || host.ends_with(&format!(".{known}"))).then_some(*provider)
    })?;
    let path = path.split(['?', '#']).next().unwrap_or("/");
    if path.len() > 256 || path.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    Some((format!("https://{host}{path}"), provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_urls_are_restricted_and_stripped() {
        assert_eq!(
            sanitize_meeting_url("https://meet.google.com/abc-defg-hij?authuser=1#x"),
            Some(("https://meet.google.com/abc-defg-hij".into(), "google_meet"))
        );
        assert_eq!(
            sanitize_meeting_url("https://us02web.zoom.us/j/123?pwd=secret").map(|v| v.0),
            Some("https://us02web.zoom.us/j/123".into())
        );
        for bad in [
            "http://meet.google.com/x",
            "https://evil.com/meet.google.com",
            "https://meet.google.com.evil.com/x",
            "https://user@meet.google.com/x",
            "https://meet.google.com:444/x",
            "javascript:alert(1)",
        ] {
            assert_eq!(sanitize_meeting_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn external_ids_and_text() {
        assert!(valid_external_id("cl_01HZX.a:b-c"));
        assert!(!valid_external_id(""));
        assert!(!valid_external_id("a b"));
        assert!(!valid_external_id(&"a".repeat(129)));
        assert_eq!(clean_text("  Acme  ", 10), Some("Acme".into()));
        assert_eq!(clean_text("a\u{0}b", 10), None);
        assert_eq!(clean_text("   ", 10), None);
    }

    fn pairing(kind: PairingKind) -> CreatePairingRequest {
        CreatePairingRequest {
            request_id: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b".into(),
            tenant_id: "calari".into(),
            pairing_kind: kind,
            client_id: Some("2b0c6a1e-3d4f-4a5b-8c7d-9e0f1a2b3c4d".into()),
            intake_receipt_id: Some("7a8b9c0d-1e2f-4a3b-8c5d-6e7f8a9b0c1d".into()),
            client_display_name: Some("Acme".into()),
            ttl_seconds: 600,
            pkce_challenge: None,
            pkce_method: None,
        }
    }

    #[test]
    fn pkce_fields() {
        // RFC 7636 appendix B example.
        assert_eq!(
            pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(valid_pkce_verifier(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        ));
        assert!(!valid_pkce_verifier("short"));
        let mut p = pairing(PairingKind::StaffClient);
        p.pkce_challenge = Some(pkce_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert!(p.validate().is_err(), "method required");
        p.pkce_method = Some("S256".into());
        assert!(p.validate().is_ok());
        p.pkce_method = Some("plain".into());
        assert!(p.validate().is_err());
        p.pkce_challenge = Some("not-a-challenge".into());
        p.pkce_method = Some("S256".into());
        assert!(p.validate().is_err());
    }

    #[test]
    fn pairing_kinds_bind_client_fields() {
        assert!(pairing(PairingKind::ClientIntake).validate().is_ok());
        assert!(pairing(PairingKind::StaffClient).validate().is_ok());
        assert!(pairing(PairingKind::InternalTeam).validate().is_err());
        let mut internal = pairing(PairingKind::InternalTeam);
        internal.client_id = None;
        internal.intake_receipt_id = None;
        assert!(internal.validate().is_ok());
        let mut no_receipt = pairing(PairingKind::ClientIntake);
        no_receipt.intake_receipt_id = None;
        assert!(no_receipt.validate().is_err());
        let mut by_name = pairing(PairingKind::StaffClient);
        by_name.client_id = Some("Acme Ltd".into());
        assert!(by_name.validate().is_err());
        let mut long = pairing(PairingKind::StaffClient);
        long.ttl_seconds = 3600;
        assert!(long.validate().is_err());
        let mut bad_req = pairing(PairingKind::StaffClient);
        bad_req.request_id = "retry-1".into();
        assert!(bad_req.validate().is_err());
    }

    #[test]
    fn stop_reasons_round_trip() {
        assert_eq!(StopReason::parse("hard_limit"), Some(StopReason::HardLimit));
        assert_eq!(StopReason::parse("nope"), None);
        assert_eq!(StopReason::TabClosed.as_str(), "tab_closed");
    }

    #[test]
    fn event_ids_are_stable_per_revision() {
        assert_eq!(delivery_event_id("mtg_a", 1), delivery_event_id("mtg_a", 1));
        assert_ne!(delivery_event_id("mtg_a", 1), delivery_event_id("mtg_a", 2));
        assert_ne!(delivery_event_id("mtg_a", 1), delivery_event_id("mtg_b", 1));
        assert!(crate::ids::parse_uuid(&delivery_event_id("mtg_a", 1)).is_some());
    }
}

// ---- Calendar attendance (Cap → Calari, signed purpose `calendar`) ----
// See docs/integrations/calari/CALENDAR-PORTAL-CONTRACT.md.

/// Most attendee emails sent in one resolve request.
pub const MAX_CALENDAR_ATTENDEES: usize = 100;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarResolveRequest {
    pub user_id: String,
    pub attendee_emails: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarClientMapping {
    pub email: String,
    pub client_id: String,
    /// Shown to the staff member when choosing; never used for matching.
    pub client_display_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarResolveResponse {
    pub tenant_id: String,
    pub user_id: String,
    pub active: bool,
    #[serde(default)]
    pub mappings: Vec<CalendarClientMapping>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarPairingRequest {
    pub request_id: String,
    pub user_id: String,
    /// `staff_client` with a client, or `internal_team` (explicit staff
    /// choice only) without one. A missing client never means internal.
    pub pairing_kind: PairingKind,
    pub client_id: Option<String>,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CalendarPairingResponse {
    pub pairing_id: String,
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for CalendarPairingResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CalendarPairingResponse")
            .field("pairing_id", &self.pairing_id)
            .field("code", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

// ---- Cancel before audio (device → Cap) ----

/// Why a recording is cancelled before any audio was uploaded.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    CaptureFailed,
    DeviceUnavailable,
    UserCancelled,
}

impl CancelReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CancelReason::CaptureFailed => "capture_failed",
            CancelReason::DeviceUnavailable => "device_unavailable",
            CancelReason::UserCancelled => "user_cancelled",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CancelMeetingRequest {
    pub reason: CancelReason,
}

/// Failure text prefix for a meeting cancelled before audio.
pub const CANCELLED_BEFORE_AUDIO: &str = "cancelled_before_audio";
/// Failure text prefix for an empty recording closed by the server sweep.
pub const NO_AUDIO: &str = "no_audio";
