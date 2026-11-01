//! Number-only exports so the extension can load the detector with plain
//! `WebAssembly.instantiate` and no generated JS glue.
//!
//! One detector per module instance (one recording per offscreen document).
//! Times are milliseconds as `f64` because JS numbers are doubles.
//!
//! `tick` return codes: 0 continue, 1 warn, 2 stop. After a 1 or 2, read
//! `reason_code` and, for 1, `stop_at_ms`.
//!
//! Reason codes: 1 user_stopped, 2 meeting_ended, 3 tab_closed,
//! 4 window_closed, 5 device_lost, 6 prolonged_inactivity, 7 hard_limit,
//! 10 warn_inactivity, 11 warn_hard_limit (soft-signal warnings use the stop
//! reason they will become).

// `#[no_mangle]` is the only reason this crate is not `forbid(unsafe_code)`:
// the exported symbol names are the module's ABI.
#![allow(unsafe_code)]

use cap_meeting_detector::{Config, Decision, Detector, Signal, StopReason, WarnReason};
use core::cell::RefCell;

thread_local! {
    static STATE: RefCell<Option<(Detector, Decision)>> = const { RefCell::new(None) };
}

fn stop_code(r: StopReason) -> u32 {
    match r {
        StopReason::UserStopped => 1,
        StopReason::MeetingEnded => 2,
        StopReason::TabClosed => 3,
        StopReason::WindowClosed => 4,
        StopReason::DeviceLost => 5,
        StopReason::ProlongedInactivity => 6,
        StopReason::HardLimit => 7,
    }
}

/// Starts a detector. Any argument ≤ 0 keeps the default.
#[no_mangle]
pub extern "C" fn detector_start(
    now_ms: f64,
    idle_warning_after_ms: f64,
    idle_stop_after_warning_ms: f64,
    hard_max_ms: f64,
) {
    let mut cfg = Config::default();
    let pick = |v: f64, d: u64| if v > 0.0 { v as u64 } else { d };
    cfg.idle_warning_after_ms = pick(idle_warning_after_ms, cfg.idle_warning_after_ms);
    cfg.idle_stop_after_warning_ms =
        pick(idle_stop_after_warning_ms, cfg.idle_stop_after_warning_ms);
    cfg.hard_max_ms = pick(hard_max_ms, cfg.hard_max_ms);
    STATE.with(|s| *s.borrow_mut() = Some((Detector::new(cfg, now_ms as u64), Decision::Continue)));
}

#[no_mangle]
pub extern "C" fn detector_feed_rms(now_ms: f64, rms: f32) {
    STATE.with(|s| {
        if let Some((d, _)) = s.borrow_mut().as_mut() {
            d.feed_rms(now_ms as u64, rms)
        }
    });
}

/// 1 user stop, 2 meeting ended, 3 tab closed, 4 window closed,
/// 5 navigated away, 6 returned, 7 device lost, 8 device restored,
/// 9 keep recording, 10 pause, 11 resume. Unknown codes are ignored.
#[no_mangle]
pub extern "C" fn detector_signal(now_ms: f64, code: u32) {
    let signal = match code {
        1 => Signal::UserStop,
        2 => Signal::MeetingEnded,
        3 => Signal::TabClosed,
        4 => Signal::WindowClosed,
        5 => Signal::NavigatedAway,
        6 => Signal::Returned,
        7 => Signal::DeviceLost,
        8 => Signal::DeviceRestored,
        9 => Signal::KeepRecording,
        10 => Signal::Pause,
        11 => Signal::Resume,
        _ => return,
    };
    STATE.with(|s| {
        if let Some((d, _)) = s.borrow_mut().as_mut() {
            d.signal(now_ms as u64, signal)
        }
    });
}

#[no_mangle]
pub extern "C" fn detector_tick(now_ms: f64) -> u32 {
    STATE.with(|s| match s.borrow_mut().as_mut() {
        Some((d, last)) => {
            *last = d.tick(now_ms as u64);
            match last {
                Decision::Continue => 0,
                Decision::Warn { .. } => 1,
                Decision::Stop { .. } => 2,
            }
        }
        None => 0,
    })
}

#[no_mangle]
pub extern "C" fn detector_reason_code() -> u32 {
    STATE.with(|s| match s.borrow().as_ref().map(|(_, d)| *d) {
        Some(Decision::Stop { reason }) => stop_code(reason),
        Some(Decision::Warn { reason, .. }) => match reason {
            WarnReason::Inactivity => 10,
            WarnReason::HardLimitApproaching => 11,
            WarnReason::SoftSignal(r) => stop_code(r),
        },
        _ => 0,
    })
}

#[no_mangle]
pub extern "C" fn detector_stop_at_ms() -> f64 {
    STATE.with(|s| match s.borrow().as_ref().map(|(_, d)| *d) {
        Some(Decision::Warn { stop_at_ms, .. }) => stop_at_ms as f64,
        _ => -1.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_api_drives_the_detector() {
        detector_start(0.0, 1_000.0, 1_000.0, 0.0);
        assert_eq!(detector_tick(10.0), 0);
        assert_eq!(detector_tick(1_000.0), 1);
        assert_eq!(detector_reason_code(), 10);
        assert_eq!(detector_stop_at_ms(), 2_000.0);
        detector_signal(1_500.0, 9);
        assert_eq!(detector_tick(1_500.0), 0);
        detector_signal(1_600.0, 3);
        assert_eq!(detector_tick(1_600.0), 2);
        assert_eq!(detector_reason_code(), 3);
    }
}
