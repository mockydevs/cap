//! Google Meet as an unauthenticated, clearly named guest. The bot asks to
//! join and waits for the host; it never bypasses the waiting room, a
//! sign-in requirement or any challenge. If Meet refuses, it reports why.

use crate::cdp::{Browser, Result};
use serde::Deserialize;
use std::time::{Duration, Instant};

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
    #[serde(default)]
    pub refused: bool,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub leave: Option<[f64; 2]>,
    /// Meet's "Continue without microphone/camera" prompt, shown when the
    /// browser has no usable devices (the notetaker on purpose).
    #[serde(default)]
    pub without_media: Option<[f64; 2]>,
}

/// Reads what the page shows. Returns element centres for trusted clicks.
const PROBE: &str = r#"(() => {
  const text = document.body ? document.body.innerText : '';
  const has = (...s) => s.some(x => text.includes(x));
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const at = el => { if (!vis(el)) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const inputs = [...document.querySelectorAll('input[type="text"],input:not([type])')].filter(vis);
  const name = inputs.find(i => /name/i.test((i.getAttribute('aria-label') || '') + (i.placeholder || ''))) || inputs[0];
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(vis);
  const label = b => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
  const join = buttons.find(b => /^(ask to join|join now|join)$/i.test((b.innerText || '').trim()));
  const mic = buttons.find(b => /turn off microphone/i.test(label(b)));
  const cam = buttons.find(b => /turn off camera/i.test(label(b)));
  const leave = buttons.find(b => /^leave call/i.test(b.getAttribute('aria-label') || ''));
  const withoutMedia = buttons.find(b => /^continue without (microphone|camera)/i.test((b.innerText || '').trim()));
  return {
    name_input: name ? at(name) : null,
    name_filled: !!(name && name.value && name.value.trim().length > 0),
    join: join ? at(join) : null,
    mic_on: mic ? at(mic) : null,
    cam_on: cam ? at(cam) : null,
    waiting: has('Asking to be let in', "You'll join the call when someone lets you in", 'You’ll join the call when someone lets you in', 'Waiting for the host'),
    in_call: !!leave,
    leave: leave ? at(leave) : null,
    without_media: withoutMedia ? at(withoutMedia) : null,
    refused: has("You can't join this video call", 'You can’t join this video call', 'denied your request', "weren't allowed to join", 'weren’t allowed to join', 'Check your meeting code', 'Meeting not found'),
    ended: has('You left the meeting', 'You have been removed', 'removed you from the meeting', 'The meeting has ended', 'Call ended', 'This call has ended')
  };
})()"#;

pub fn probe(b: &mut Browser) -> Result<PageState> {
    let v = b.eval(PROBE)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinOutcome {
    Admitted,
    /// Meet refused the guest (sign-in required, denied, not found).
    Refused,
    /// Nobody admitted the bot before the waiting limit.
    NotAdmitted,
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

pub fn join(b: &mut Browser, url: &str, o: JoinOptions<'_>) -> Result<JoinOutcome> {
    b.navigate(url)?;
    let start = Instant::now();
    let mut asked_at: Option<Instant> = None;
    let mut reported_waiting = false;
    loop {
        std::thread::sleep(Duration::from_millis(700));
        if !(o.keep_going)() {
            return Ok(JoinOutcome::Stopped);
        }
        let s = probe(b)?;
        if s.in_call && !s.waiting {
            return Ok(JoinOutcome::Admitted);
        }
        if s.refused {
            return Ok(JoinOutcome::Refused);
        }
        if s.waiting {
            if !reported_waiting {
                reported_waiting = true;
                (o.on_waiting)();
            }
            if asked_at.get_or_insert_with(Instant::now).elapsed() > o.waiting_timeout {
                return Ok(JoinOutcome::NotAdmitted);
            }
            continue;
        }
        if asked_at.is_none() {
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
            if let Some([x, y]) = s.join {
                b.click(x, y)?;
                asked_at = Some(Instant::now());
                continue;
            }
            if start.elapsed() > o.page_load_timeout {
                return Ok(JoinOutcome::Refused);
            }
        } else if asked_at.is_some_and(|t| t.elapsed() > o.waiting_timeout) {
            return Ok(JoinOutcome::NotAdmitted);
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
}
