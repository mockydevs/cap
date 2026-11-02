//! Calendar scheduling policy. Decisions are made from persisted, tenant-scoped
//! facts; event titles and meeting chat are never client-routing instructions.
use chrono::{DateTime, Utc};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum ClientMatch {
    Matched(Uuid),
    NeedsReview,
}

/// The caller must fetch mappings within the authenticated tenant and validate
/// an explicit selection's access before passing it here. Only exact verified
/// email mappings qualify; domains and display names deliberately do not.
pub fn match_client(
    explicit: Option<Uuid>,
    attendees: &[String],
    verified_mappings: &[(String, Uuid)],
) -> ClientMatch {
    if let Some(id) = explicit {
        return ClientMatch::Matched(id);
    }
    let emails: BTreeSet<_> = attendees.iter().map(|e| e.trim().to_lowercase()).collect();
    let clients: BTreeSet<_> = verified_mappings
        .iter()
        .filter(|(email, _)| emails.contains(&email.trim().to_lowercase()))
        .map(|(_, id)| *id)
        .collect();
    if clients.len() == 1 {
        ClientMatch::Matched(*clients.first().expect("one client"))
    } else {
        ClientMatch::NeedsReview
    }
}

/// Accept only the public Google Meet join form. No arbitrary URLs, redirects,
/// credentials, ports or query strings are sent to a recording worker.
pub fn google_meet_code(input: &str) -> Option<String> {
    let url = reqwest::Url::parse(input).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("meet.google.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let path = url.path().strip_prefix('/')?;
    let bytes = path.as_bytes();
    (bytes.len() == 12
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 3 || i == 8 {
                *b == b'-'
            } else {
                b.is_ascii_lowercase()
            }
        }))
    .then(|| path.to_owned())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Cancel,
    NeedsClient,
    Schedule {
        client_id: Uuid,
        meeting_code: String,
    },
}

pub struct Event<'a> {
    pub connected: bool,
    pub enabled: bool,
    pub deleted: bool,
    pub declined: bool,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub meeting_url: &'a str,
    pub client: ClientMatch,
}

/// A cancelled, declined, disconnected or already-started event cannot create
/// a new bot. Reconciliation must cancel an existing schedule on `Cancel`.
pub fn decide(event: Event<'_>, now: DateTime<Utc>) -> Decision {
    if !event.connected
        || !event.enabled
        || event.deleted
        || event.declined
        || event.starts_at <= now
        || event.ends_at <= event.starts_at
    {
        return Decision::Cancel;
    }
    let Some(meeting_code) = google_meet_code(event.meeting_url) else {
        return Decision::Cancel;
    };
    match event.client {
        ClientMatch::Matched(client_id) => Decision::Schedule {
            client_id,
            meeting_code,
        },
        ClientMatch::NeedsReview => Decision::NeedsClient,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ambiguous_or_unknown_attendees_never_guess() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mappings = vec![("a@example.com".into(), a), ("b@example.com".into(), b)];
        assert_eq!(
            match_client(None, &[" A@example.com ".into()], &mappings),
            ClientMatch::Matched(a)
        );
        assert_eq!(
            match_client(
                None,
                &["a@example.com".into(), "b@example.com".into()],
                &mappings
            ),
            ClientMatch::NeedsReview
        );
        assert_eq!(
            match_client(None, &["other@example.com".into()], &mappings),
            ClientMatch::NeedsReview
        );
        assert_eq!(
            match_client(Some(a), &["b@example.com".into()], &mappings),
            ClientMatch::Matched(a)
        );
    }
    #[test]
    fn worker_destination_is_a_meet_code_not_a_url() {
        assert_eq!(
            google_meet_code("https://meet.google.com/abc-defg-hij?authuser=1"),
            Some("abc-defg-hij".into())
        );
        for url in [
            "http://meet.google.com/abc-defg-hij",
            "https://meet.google.com.evil.test/abc-defg-hij",
            "https://user@meet.google.com/abc-defg-hij",
            "https://meet.google.com:444/abc-defg-hij",
            "https://127.0.0.1/abc-defg-hij",
            "https://meet.google.com/abc-defg-hij/extra",
        ] {
            assert_eq!(google_meet_code(url), None, "{url}");
        }
    }
    #[test]
    fn disconnect_cancel_decline_and_past_events_cancel() {
        let now = Utc::now();
        for flag in 0..6 {
            let event = Event {
                connected: flag != 0,
                enabled: flag != 1,
                deleted: flag == 2,
                declined: flag == 3,
                starts_at: now + chrono::Duration::minutes(if flag == 4 { -1 } else { 5 }),
                ends_at: now + chrono::Duration::minutes(60),
                meeting_url: "https://meet.google.com/abc-defg-hij",
                client: ClientMatch::Matched(Uuid::nil()),
            };
            let actual = decide(event, now);
            if flag < 5 {
                assert_eq!(actual, Decision::Cancel);
            } else {
                assert!(matches!(actual, Decision::Schedule { .. }));
            }
        }
    }
}
