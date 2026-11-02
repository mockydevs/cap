//! Read-only Google Calendar transport. Refresh tokens must be supplied by the
//! encrypted credential store, never by a browser or a job payload.
use chrono::{DateTime, Utc};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPage {
    #[serde(default)]
    pub items: Vec<CalendarEvent>,
    pub next_page_token: Option<String>,
    pub next_sync_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub updated: Option<DateTime<Utc>>,
    pub start: Option<EventTime>,
    pub end: Option<EventTime>,
    pub hangout_link: Option<String>,
    pub conference_data: Option<ConferenceData>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    pub organizer: Option<Organizer>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Organizer {
    #[serde(default, rename = "self")]
    pub is_self: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConferenceData {
    #[serde(default)]
    pub entry_points: Vec<EntryPoint>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPoint {
    pub entry_point_type: Option<String>,
    pub uri: Option<String>,
}

impl CalendarEvent {
    /// The Google Meet join link, from `hangoutLink` or the video entry point.
    pub fn meet_url(&self) -> Option<&str> {
        self.hangout_link.as_deref().or_else(|| {
            self.conference_data.as_ref().and_then(|c| {
                c.entry_points
                    .iter()
                    .find(|e| e.entry_point_type.as_deref() == Some("video"))
                    .and_then(|e| e.uri.as_deref())
            })
        })
    }

    pub fn is_cancelled(&self) -> bool {
        self.status.as_deref() == Some("cancelled")
    }

    /// The connected user declined (only their own response counts).
    /// The connected user organises the meeting or has accepted it. Invites
    /// they have not answered (Google adds them automatically) or answered
    /// "maybe" never bring the notetaker.
    pub fn self_accepted(&self) -> bool {
        let organizer = self.organizer.as_ref().is_some_and(|o| o.is_self);
        match self.attendees.iter().find(|a| a.is_self) {
            Some(me) => me.response_status.as_deref() == Some("accepted"),
            // No guest list: only the organiser's own event counts.
            None => organizer,
        }
    }

    pub fn self_declined(&self) -> bool {
        self.attendees
            .iter()
            .any(|a| a.is_self && a.response_status.as_deref() == Some("declined"))
    }

    /// Exact lowercased attendee emails other than the connected user.
    pub fn other_attendee_emails(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .attendees
            .iter()
            .filter(|a| !a.is_self)
            .filter_map(|a| a.email.as_deref())
            .map(|e| e.trim().to_lowercase())
            .filter(|e| e.len() <= 254 && e.contains('@'))
            .collect();
        out.sort();
        out.dedup();
        out
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTime {
    pub date_time: Option<DateTime<Utc>>,
    pub date: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub email: Option<String>,
    pub response_status: Option<String>,
    #[serde(default, rename = "self")]
    pub is_self: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    #[error("calendar access must be reconnected")]
    Reconnect,
    #[error("calendar sync cursor expired; perform a full resync")]
    FullResync,
    #[error("calendar request temporarily failed")]
    Retry,
    #[error("calendar returned an invalid response")]
    Invalid,
}

/// Bounded response read. Neither provider error bodies nor tokens are included
/// in errors (provider responses can contain user data).
async fn bounded_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, CalendarError> {
    match response.status().as_u16() {
        401 | 403 => return Err(CalendarError::Reconnect),
        410 => return Err(CalendarError::FullResync),
        429 | 500..=599 => return Err(CalendarError::Retry),
        200 => (),
        _ => return Err(CalendarError::Invalid),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CalendarError::Retry)? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(CalendarError::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| CalendarError::Invalid)
}

/// One page of the primary calendar inside a bounded window. Recurring
/// series are expanded into instances (`singleEvents`), so `time_max` is
/// what keeps an endless series finite. Every page of a run must repeat the
/// same window; only `page_token` changes.
pub async fn primary_events(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
    page_token: Option<&str>,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
) -> Result<CalendarPage, CalendarError> {
    let time_min = time_min.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let time_max = time_max.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut query = vec![
        ("singleEvents", "true"),
        ("showDeleted", "true"),
        ("maxResults", "250"),
        ("timeMin", time_min.as_str()),
        ("timeMax", time_max.as_str()),
    ];
    if let Some(token) = page_token {
        query.push(("pageToken", token));
    }
    let response = client
        .get(format!("{api_base}/calendar/v3/calendars/primary/events"))
        .bearer_auth(access_token)
        .query(&query)
        .send()
        .await
        .map_err(|_| CalendarError::Retry)?;
    bounded_json(response).await
}

/// Read-only calendar events plus the account email for display/matching.
pub const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar.events.readonly";
pub const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub scope: String,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenResponse(<redacted>)")
    }
}

#[derive(Deserialize)]
struct OauthError {
    error: Option<String>,
}

async fn token_request(
    client: &reqwest::Client,
    token_url: &str,
    form: &[(&str, &str)],
) -> Result<TokenResponse, CalendarError> {
    let response = client
        .post(token_url)
        .form(form)
        .send()
        .await
        .map_err(|_| CalendarError::Retry)?;
    let status = response.status().as_u16();
    if status == 400 || status == 401 {
        // invalid_grant: revoked, expired or password changed.
        let body: Option<OauthError> = response.json().await.ok();
        return Err(match body.and_then(|b| b.error).as_deref() {
            Some("invalid_grant") | Some("unauthorized_client") | Some("invalid_client") => {
                CalendarError::Reconnect
            }
            _ => CalendarError::Invalid,
        });
    }
    bounded_json(response).await
}

/// Authorization code + PKCE verifier → tokens (server to server).
pub async fn exchange_code(
    client: &reqwest::Client,
    cfg: &crate::config::CalendarConfig,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, CalendarError> {
    token_request(
        client,
        &cfg.google.token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("client_id", &cfg.google_client_id),
            ("client_secret", &cfg.google_client_secret.0),
        ],
    )
    .await
}

pub async fn refresh(
    client: &reqwest::Client,
    cfg: &crate::config::CalendarConfig,
    refresh_token: &str,
) -> Result<String, CalendarError> {
    token_request(
        client,
        &cfg.google.token_url,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &cfg.google_client_id),
            ("client_secret", &cfg.google_client_secret.0),
        ],
    )
    .await
    .map(|t| t.access_token)
}

/// Best effort: a token Google no longer knows is already revoked.
pub async fn revoke(
    client: &reqwest::Client,
    cfg: &crate::config::CalendarConfig,
    token: &str,
) -> bool {
    match client
        .post(&cfg.google.revoke_url)
        .form(&[("token", token)])
        .send()
        .await
    {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 400,
        Err(_) => false,
    }
}

#[derive(Deserialize)]
pub struct UserInfo {
    pub email: String,
    #[serde(default)]
    pub email_verified: bool,
}

pub async fn user_info(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
) -> Result<UserInfo, CalendarError> {
    let response = client
        .get(format!("{api_base}/oauth2/v3/userinfo"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| CalendarError::Retry)?;
    bounded_json(response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_events_need_no_time_or_attendees() {
        let event: CalendarEvent =
            serde_json::from_str(r#"{"id":"gone","status":"cancelled"}"#).unwrap();
        assert!(event.start.is_none());
        assert!(event.attendees.is_empty());
    }
    #[test]
    fn timestamps_preserve_offsets_and_self_decline() {
        let event: CalendarEvent = serde_json::from_str(r#"{"id":"meeting","start":{"dateTime":"2026-11-02T09:00:00-05:00"},"attendees":[{"email":"don@example.com","self":true,"responseStatus":"declined"}]}"#).unwrap();
        assert_eq!(
            event.start.unwrap().date_time.unwrap().to_rfc3339(),
            "2026-11-02T14:00:00+00:00"
        );
        assert!(event.attendees[0].is_self);
        assert_eq!(
            event.attendees[0].response_status.as_deref(),
            Some("declined")
        );
    }
}

#[cfg(test)]
mod event_tests {
    use super::*;
    #[test]
    fn meet_link_falls_back_to_video_entry_point_and_self_is_excluded() {
        let event: CalendarEvent = serde_json::from_str(r#"{"id":"m","conferenceData":{"entryPoints":[{"entryPointType":"phone","uri":"tel:+1"},{"entryPointType":"video","uri":"https://meet.google.com/abc-defg-hij"}]},"attendees":[{"email":"Don@Example.com","self":true},{"email":" Client@Acme.com "},{"email":"client@acme.com"},{"email":"not-an-email"}]}"#).unwrap();
        assert_eq!(
            event.meet_url(),
            Some("https://meet.google.com/abc-defg-hij")
        );
        assert_eq!(
            event.other_attendee_emails(),
            vec!["client@acme.com".to_owned()]
        );
        assert!(!event.self_declined());
        assert!(!event.self_accepted(), "self not listed and not organiser");
    }

    #[test]
    fn only_accepted_or_organised_events_count() {
        let ev = |j: &str| serde_json::from_str::<CalendarEvent>(j).unwrap();
        assert!(ev(
            r#"{"id":"a","attendees":[{"email":"me@x","self":true,"responseStatus":"accepted"}]}"#
        )
        .self_accepted());
        for status in ["needsAction", "tentative", "declined"] {
            let j = format!(
                r#"{{"id":"a","attendees":[{{"email":"me@x","self":true,"responseStatus":"{status}"}}]}}"#
            );
            assert!(!ev(&j).self_accepted(), "{status}");
        }
        assert!(ev(r#"{"id":"a","organizer":{"self":true}}"#).self_accepted());
        assert!(!ev(r#"{"id":"a","organizer":{"email":"outsider@evil.test"}}"#).self_accepted());
    }
}
