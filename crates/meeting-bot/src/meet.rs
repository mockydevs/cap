//! Google Meet as an unauthenticated, clearly named guest. The bot asks to
//! join and waits for the host; it never bypasses the waiting room, a
//! sign-in requirement or any challenge. If Meet refuses, it reports why.
//!
//! What it reports is a fixed vocabulary only (reason codes, page kinds,
//! counts, known-phrase flags): no page text, URLs, names or tokens leave
//! the browser, so the evidence is safe to log and store.

use crate::cdp::{Browser, NetStats, Result};
use serde::Deserialize;
use std::{
    fmt,
    time::{Duration, Instant},
};

pub const MEET_ORIGIN: &str = "https://meet.google.com";

/// Same rule as the server: `xxx-xxxx-xxx`, lowercase letters only.
pub fn valid_code(code: &str) -> bool {
    let b = code.as_bytes();
    b.len() == 12
        && b.iter().enumerate().all(|(i, c)| {
            if i == 3 || i == 8 {
                *c == b'-'
            } else {
                c.is_ascii_lowercase()
            }
        })
}

#[derive(Debug, Default, Deserialize, PartialEq)]
pub struct PageState {
    #[serde(default)]
    pub name_input: Option<[f64; 2]>,
    #[serde(default)]
    pub name_filled: bool,
    /// An enabled join button ("Ask to join", "Join now", "Join").
    #[serde(default)]
    pub join: Option<[f64; 2]>,
    #[serde(default)]
    pub mic_on: Option<[f64; 2]>,
    #[serde(default)]
    pub cam_on: Option<[f64; 2]>,
    #[serde(default)]
    pub waiting: bool,
    #[serde(default)]
    pub in_call: bool,
    /// Id of the refusal phrase Meet shows, from `RefusalReason`'s list.
    #[serde(default)]
    pub refused: Option<String>,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub leave: Option<[f64; 2]>,
    /// Meet's "Continue without microphone/camera" prompt, shown when the
    /// browser has no usable devices (the notetaker on purpose).
    #[serde(default)]
    pub without_media: Option<[f64; 2]>,
    /// Ids of known page phrases/conditions (see `FLAGS`).
    #[serde(default)]
    pub flags: Vec<String>,
    /// Location parts, used only to classify the page; never reported.
    #[serde(default)]
    pub scheme: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub code_path: bool,
    #[serde(default)]
    pub ready: String,
    #[serde(default)]
    pub buttons: u32,
    #[serde(default)]
    pub inputs: u32,
}

/// Reads what the page shows. Returns element centres for trusted clicks and
/// fixed ids for what it recognises; no page text is returned.
const PROBE: &str = r#"(() => {
  const text = document.body ? document.body.innerText : '';
  const has = (...s) => s.some(x => text.includes(x));
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const at = el => { if (!vis(el)) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const inputs = [...document.querySelectorAll('input[type="text"],input:not([type])')].filter(vis);
  const name = inputs.find(i => /name/i.test((i.getAttribute('aria-label') || '') + (i.placeholder || ''))) || inputs[0];
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(vis);
  const label = b => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
  const joinEl = buttons.find(b => /^(ask to join|join now|join)$/i.test((b.innerText || '').trim()));
  const joinDisabled = !!joinEl && (joinEl.disabled || joinEl.getAttribute('aria-disabled') === 'true');
  const mic = buttons.find(b => /turn off microphone/i.test(label(b)));
  const cam = buttons.find(b => /turn off camera/i.test(label(b)));
  const leave = buttons.find(b => /^leave call/i.test(b.getAttribute('aria-label') || ''));
  const withoutMedia = buttons.find(b => /^continue without (microphone|camera)/i.test((b.innerText || '').trim()));
  const refusals = [
    ['cant_join', ["You can't join this video call", 'You can’t join this video call']],
    ['denied', ['denied your request']],
    ['not_allowed', ["weren't allowed to join", 'weren’t allowed to join']],
    ['bad_code', ['Check your meeting code']],
    ['not_found', ['Meeting not found']]
  ];
  const refused = (refusals.find(([, s]) => has(...s)) || [null])[0];
  const known = [
    ['unsupported_browser', ["isn't supported", 'isn’t supported', 'not supported', 'Unsupported browser']],
    ['getting_ready', ['Getting ready']],
    ['return_home', ['Return to home screen']],
    ['cant_create', ["can't create a meeting", 'can’t create a meeting']],
    ['sign_in_prompt', ['Sign in to join', 'sign in with a Google account', 'Sign in with your Google account']],
    ['policy_page', ['ERR_BLOCKED_BY_ADMINISTRATOR', 'blocked by your administrator', "organization doesn't allow", 'organization doesn’t allow']],
    ['no_network', ['ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION']],
    ['someone_in_call', ['is in this call', 'are in this call', 'No one else is here']]
  ];
  const flags = known.filter(([, s]) => has(...s)).map(([k]) => k);
  if (joinDisabled) flags.push('join_disabled');
  if (!joinEl && buttons.some(b => /join/i.test(label(b)))) flags.push('join_variant');
  return {
    name_input: name ? at(name) : null,
    name_filled: !!(name && name.value && name.value.trim().length > 0),
    join: joinEl && !joinDisabled ? at(joinEl) : null,
    mic_on: mic ? at(mic) : null,
    cam_on: cam ? at(cam) : null,
    waiting: has('Asking to be let in', "You'll join the call when someone lets you in", 'You’ll join the call when someone lets you in', 'Waiting for the host'),
    in_call: !!leave,
    leave: leave ? at(leave) : null,
    without_media: withoutMedia ? at(withoutMedia) : null,
    refused,
    ended: has('You left the meeting', 'You have been removed', 'removed you from the meeting', 'The meeting has ended', 'Call ended', 'This call has ended'),
    flags,
    scheme: location.protocol,
    host: location.host,
    code_path: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(location.pathname),
    ready: document.readyState,
    buttons: buttons.length,
    inputs: inputs.length
  };
})()"#;

pub fn probe(b: &mut Browser) -> Result<PageState> {
    let v = b.eval(PROBE)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// What Meet said when it refused, recognised from fixed phrases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// "You can't join this video call" (guest access blocked or refused).
    CantJoin,
    /// The host denied the request to join.
    Denied,
    /// "You weren't allowed to join" (asked too often or removed).
    NotAllowed,
    BadCode,
    NotFound,
}

impl RefusalReason {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cant_join" => Self::CantJoin,
            "denied" => Self::Denied,
            "not_allowed" => Self::NotAllowed,
            "bad_code" => Self::BadCode,
            "not_found" => Self::NotFound,
            _ => return None,
        })
    }
    pub fn code(self) -> &'static str {
        match self {
            Self::CantJoin => "cant_join",
            Self::Denied => "denied",
            Self::NotAllowed => "not_allowed",
            Self::BadCode => "bad_code",
            Self::NotFound => "not_found",
        }
    }
}

/// Flags the probe may return; anything else is dropped.
const FLAGS: &[&str] = &[
    "unsupported_browser",
    "getting_ready",
    "return_home",
    "cant_create",
    "sign_in_prompt",
    "policy_page",
    "no_network",
    "someone_in_call",
    "join_disabled",
    "join_variant",
];

/// A safe summary of the Meet page and the join attempt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Diag {
    /// meet/code, meet/other, google_sign_in, google_consent, google_other,
    /// browser_error, blank, other.
    pub page: &'static str,
    pub ready: &'static str,
    /// none, empty, filled.
    pub name: &'static str,
    /// none, ready, disabled.
    pub join: &'static str,
    pub media_prompt: bool,
    pub buttons: u32,
    pub inputs: u32,
    pub flags: Vec<&'static str>,
    pub net: NetStats,
    /// The join button was clicked.
    pub asked: bool,
    /// Meet showed the waiting room ("Asking to be let in").
    pub waited: bool,
    pub secs: u64,
}

impl Diag {
    fn of(s: &PageState, meet_host: &str) -> Self {
        let page = match (s.scheme.as_str(), s.host.as_str()) {
            ("http:" | "https:", h) if h == meet_host && s.code_path => "meet/code",
            ("http:" | "https:", h) if h == meet_host => "meet/other",
            ("https:", "accounts.google.com") => "google_sign_in",
            ("https:", "consent.google.com") => "google_consent",
            ("https:", h) if h == "google.com" || h.ends_with(".google.com") => "google_other",
            ("chrome-error:", _) => "browser_error",
            ("about:", _) | ("", _) => "blank",
            _ => "other",
        };
        let ready = match s.ready.as_str() {
            "loading" => "loading",
            "interactive" => "interactive",
            "complete" => "complete",
            _ => "unknown",
        };
        let name = match (s.name_input, s.name_filled) {
            (None, _) => "none",
            (Some(_), false) => "empty",
            (Some(_), true) => "filled",
        };
        let flags: Vec<&'static str> = FLAGS
            .iter()
            .copied()
            .filter(|f| s.flags.iter().any(|g| g == f))
            .collect();
        let join = if s.join.is_some() {
            "ready"
        } else if flags.contains(&"join_disabled") {
            "disabled"
        } else {
            "none"
        };
        Self {
            page,
            ready,
            name,
            join,
            media_prompt: s.without_media.is_some(),
            buttons: s.buttons.min(999),
            inputs: s.inputs.min(999),
            flags,
            ..Self::default()
        }
    }

    /// Same page, ignoring time and counters that churn every probe.
    fn same_view(&self, o: &Self) -> bool {
        (
            self.page,
            self.ready,
            self.name,
            self.join,
            self.media_prompt,
            &self.flags,
        ) == (o.page, o.ready, o.name, o.join, o.media_prompt, &o.flags)
            && (self.asked, self.waited) == (o.asked, o.waited)
    }
}

impl fmt::Display for Diag {
    /// Compact (fits the server's 200-character failure note with a prefix).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let yn = |b: bool| if b { "y" } else { "n" };
        write!(
            f,
            "page={} ready={} name={} join={} prompt={} asked={} waited={} t={}s btn={} in={}",
            self.page,
            self.ready,
            self.name,
            self.join,
            yn(self.media_prompt),
            yn(self.asked),
            yn(self.waited),
            self.secs,
            self.buttons,
            self.inputs,
        )?;
        if !self.flags.is_empty() {
            write!(f, " flags={}", self.flags.join(","))?;
        }
        if !self.net.blocked.is_empty() {
            let b: Vec<String> = self
                .net
                .blocked
                .iter()
                .map(|(d, n)| format!("{d}:{n}"))
                .collect();
            write!(f, " blocked={}", b.join(","))?;
        }
        if !self.net.errors.is_empty() {
            let e: Vec<String> = self
                .net
                .errors
                .iter()
                .map(|(c, n)| format!("{c}:{n}"))
                .collect();
            write!(f, " neterr={}", e.join(","))?;
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinOutcome {
    Admitted,
    /// Meet showed one of its refusal messages.
    Refused {
        reason: RefusalReason,
        diag: Diag,
    },
    /// The page never offered an enabled join button before the page-load
    /// limit. Not a refusal: the page may not have loaded or looked
    /// different (see the diagnostics).
    NoJoinButton(Diag),
    /// Nobody admitted the bot before the waiting limit.
    NotAdmitted(Diag),
    /// Told to stop (cancelled or past the hard stop) while waiting.
    Stopped,
}

pub struct JoinOptions<'a> {
    pub display_name: &'a str,
    pub page_load_timeout: Duration,
    pub waiting_timeout: Duration,
    pub on_waiting: &'a mut dyn FnMut(),
    pub keep_going: &'a dyn Fn() -> bool,
    /// The notetaker always mutes; only the test speaker keeps its mic on.
    pub mute_microphone: bool,
}

/// `host[:port]` of a URL, for telling Meet's own pages apart.
fn url_host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#']).next().unwrap_or("")
}

pub fn join(b: &mut Browser, url: &str, o: JoinOptions<'_>) -> Result<JoinOutcome> {
    let meet_host = url_host(url).to_owned();
    b.navigate(url)?;
    let start = Instant::now();
    let mut asked_at: Option<Instant> = None;
    let mut reported_waiting = false;
    let mut logged: Option<Diag> = None;
    let mut log_lines = 0;
    loop {
        std::thread::sleep(Duration::from_millis(700));
        if !(o.keep_going)() {
            return Ok(JoinOutcome::Stopped);
        }
        let s = probe(b)?;
        let snap = |b: &Browser, asked: bool, waited: bool| {
            let mut d = Diag::of(&s, &meet_host);
            d.asked = asked;
            d.waited = waited || s.waiting;
            d.secs = start.elapsed().as_secs();
            d.net = b.net();
            d
        };
        macro_rules! diag {
            () => {
                snap(b, asked_at.is_some(), reported_waiting)
            };
        }
        // A short trail of what the page looked like, in the same safe terms.
        let now = diag!();
        if log_lines < 30 && !logged.as_ref().is_some_and(|l| l.same_view(&now)) {
            eprintln!("cap-meeting-bot: meet page: {now}");
            log_lines += 1;
            logged = Some(now);
        }
        if s.in_call && !s.waiting {
            return Ok(JoinOutcome::Admitted);
        }
        if let Some(reason) = s.refused.as_deref().and_then(RefusalReason::parse) {
            return Ok(JoinOutcome::Refused {
                reason,
                diag: diag!(),
            });
        }
        if s.waiting {
            if !reported_waiting {
                reported_waiting = true;
                (o.on_waiting)();
            }
            if asked_at.get_or_insert_with(Instant::now).elapsed() > o.waiting_timeout {
                return Ok(JoinOutcome::NotAdmitted(diag!()));
            }
            continue;
        }
        if asked_at.is_none() {
            // The page-load limit comes before any action, so a prompt that
            // never goes away (or a name box that keeps clearing) cannot
            // keep the bot here.
            if start.elapsed() > o.page_load_timeout {
                return Ok(JoinOutcome::NoJoinButton(diag!()));
            }
            // Only a muted participant may say "continue without microphone".
            if let (Some([x, y]), true) = (s.without_media, o.mute_microphone) {
                b.click(x, y)?;
                continue;
            }
            if let (Some([x, y]), true) = (s.mic_on, o.mute_microphone) {
                b.click(x, y)?;
                continue;
            }
            if let Some([x, y]) = s.cam_on {
                b.click(x, y)?;
                continue;
            }
            if let (Some([x, y]), false) = (s.name_input, s.name_filled) {
                b.click(x, y)?;
                b.insert_text(o.display_name)?;
                continue;
            }
            // Only an enabled button counts as asking; clicking a disabled
            // one does nothing and must not start the waiting clock.
            if let Some([x, y]) = s.join {
                b.click(x, y)?;
                asked_at = Some(Instant::now());
                continue;
            }
        } else if asked_at.is_some_and(|t| t.elapsed() > o.waiting_timeout) {
            return Ok(JoinOutcome::NotAdmitted(diag!()));
        }
    }
}

/// Leaves politely; the browser is closed afterwards anyway.
pub fn leave(b: &mut Browser) {
    if let Ok(PageState {
        leave: Some([x, y]),
        ..
    }) = probe(b)
    {
        let _ = b.click(x, y);
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes() {
        assert!(valid_code("abc-defg-hij"));
        for bad in [
            "abc-defg-hi",
            "ABC-defg-hij",
            "abc_defg-hij",
            "abc-defg-hij/x",
            "../../etc",
            "",
        ] {
            assert!(!valid_code(bad), "{bad}");
        }
    }

    #[test]
    fn hosts() {
        assert_eq!(
            url_host("https://meet.google.com/abc-defg-hij?hl=en"),
            "meet.google.com"
        );
        assert_eq!(
            url_host("http://127.0.0.1:4000/abc-defg-hij"),
            "127.0.0.1:4000"
        );
    }

    #[test]
    fn page_kinds_and_unknown_flags_are_dropped() {
        let s = |scheme: &str, host: &str, code_path| PageState {
            scheme: scheme.into(),
            host: host.into(),
            code_path,
            ..PageState::default()
        };
        let m = "meet.google.com";
        assert_eq!(Diag::of(&s("https:", m, true), m).page, "meet/code");
        assert_eq!(Diag::of(&s("https:", m, false), m).page, "meet/other");
        assert_eq!(
            Diag::of(&s("https:", "accounts.google.com", false), m).page,
            "google_sign_in"
        );
        assert_eq!(
            Diag::of(&s("chrome-error:", "", false), m).page,
            "browser_error"
        );
        assert_eq!(
            Diag::of(&s("https:", "evil.example", true), m).page,
            "other"
        );
        let mut p = s("https:", m, true);
        p.flags = vec!["join_disabled".into(), "<script>secret</script>".into()];
        p.ready = "secret-ready".into();
        let d = Diag::of(&p, m);
        assert_eq!(d.flags, vec!["join_disabled"]);
        assert_eq!(d.join, "disabled");
        assert_eq!(d.ready, "unknown");
    }

    #[test]
    fn worst_case_summary_fits_the_failure_note() {
        let mut d = Diag {
            page: "google_consent",
            ready: "interactive",
            name: "filled",
            join: "disabled",
            media_prompt: true,
            buttons: 999,
            inputs: 999,
            flags: FLAGS.to_vec(),
            asked: true,
            waited: true,
            secs: 99_999,
            ..Diag::default()
        };
        for dom in crate::cdp::KNOWN_DOMAINS {
            d.net.blocked.insert(dom, 999);
        }
        d.net.errors.insert("ERR_NAME_NOT_RESOLVED".into(), 999);
        let full = format!("Google Meet refused the notetaker (not_allowed): {d}");
        // The server keeps 200 characters; the most useful facts come first.
        let kept: String = full.chars().take(200).collect();
        assert!(kept.contains("page=google_consent") && kept.contains("asked=y waited=y"));
        assert!(kept.contains("btn=999 in=999"), "{kept}");
    }
}
