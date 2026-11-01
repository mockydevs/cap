//! Decides when a meeting recording should warn or stop.
//!
//! The rule is deliberately conservative: ordinary conversational silence
//! never stops a recording. A recording stops only on
//!
//! - a **hard signal** (the user pressed stop, the meeting page reported the
//!   call ended, the captured tab or watched window closed),
//! - a **soft signal** that did not recover within a grace period (the tab
//!   navigated away from the meeting, the input device disappeared),
//! - **prolonged inactivity**: no audio activity for `idle_warning_after_ms`,
//!   then a visible warning, then a further `idle_stop_after_warning_ms`
//!   with no activity and no "keep recording" from the user, or
//! - the **hard duration limit**, with its own warning beforehand.
//!
//! The detector is pure and clock-free: callers pass a monotonic `now_ms`.
//! The noise floor is the quietest level heard in the last ~10 seconds
//! (minimum statistics). Speech always has gaps between words, so the floor
//! tracks room tone underneath it; a steady fan or hum fills those gaps and
//! becomes the floor itself, so it is treated as silence within seconds.

#![no_std]

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    /// Silence before the "are you still in the meeting?" warning.
    pub idle_warning_after_ms: u64,
    /// Further silence after the warning before stopping.
    pub idle_stop_after_warning_ms: u64,
    /// How long a soft signal may last before it stops the recording.
    pub soft_signal_grace_ms: u64,
    /// Absolute maximum recording length, measured from start.
    pub hard_max_ms: u64,
    /// Warning shown this long before the hard limit.
    pub hard_max_warning_ms: u64,
    /// Level above the noise floor that counts as activity, in dB.
    pub activity_margin_db: f32,
    /// Below this absolute level nothing counts as activity, in dBFS.
    pub min_activity_dbfs: f32,
    /// Activity must persist this long to count, filtering clicks and taps.
    pub min_activity_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            idle_warning_after_ms: 6 * 60_000,
            idle_stop_after_warning_ms: 3 * 60_000,
            soft_signal_grace_ms: 90_000,
            hard_max_ms: 4 * 3_600_000,
            hard_max_warning_ms: 5 * 60_000,
            activity_margin_db: 10.0,
            min_activity_dbfs: -55.0,
            min_activity_ms: 200,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    UserStop,
    /// The meeting page or app reported the call ended.
    MeetingEnded,
    TabClosed,
    WindowClosed,
    /// The tab left the meeting page. Recovers with [`Signal::Returned`].
    NavigatedAway,
    Returned,
    /// The capture device vanished. Recovers with [`Signal::DeviceRestored`].
    DeviceLost,
    DeviceRestored,
    /// The user answered the idle warning.
    KeepRecording,
    Pause,
    Resume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    UserStopped,
    MeetingEnded,
    TabClosed,
    WindowClosed,
    DeviceLost,
    ProlongedInactivity,
    HardLimit,
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
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarnReason {
    Inactivity,
    /// Left the meeting page; carries the stop reason it will become.
    SoftSignal(StopReason),
    HardLimitApproaching,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Continue,
    /// Show a visible warning; recording stops at `stop_at_ms` unless resolved.
    Warn {
        reason: WarnReason,
        stop_at_ms: u64,
    },
    Stop {
        reason: StopReason,
    },
}

#[derive(Clone, Debug)]
pub struct Detector {
    cfg: Config,
    started_ms: u64,
    last_activity_ms: u64,
    /// Per-second minimum levels in dBFS (ring buffer); the floor is their min.
    buckets: [f32; FLOOR_BUCKETS],
    /// Index of the second the current bucket covers.
    bucket_second: Option<u64>,
    /// Start of the current above-threshold run.
    active_since_ms: Option<u64>,
    soft: Option<(StopReason, u64)>,
    paused_since_ms: Option<u64>,
    stopped: Option<StopReason>,
}

/// Seconds of history the noise floor is the minimum of.
const FLOOR_BUCKETS: usize = 10;
const SILENCE_DBFS: f32 = -100.0;

impl Detector {
    pub fn new(cfg: Config, now_ms: u64) -> Self {
        Self {
            cfg,
            started_ms: now_ms,
            last_activity_ms: now_ms,
            buckets: [f32::INFINITY; FLOOR_BUCKETS],
            bucket_second: None,
            active_since_ms: None,
            soft: None,
            paused_since_ms: None,
            stopped: None,
        }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn noise_floor_dbfs(&self) -> Option<f32> {
        let floor = self.buckets.iter().copied().fold(f32::INFINITY, f32::min);
        floor.is_finite().then_some(floor)
    }

    pub fn last_activity_ms(&self) -> u64 {
        self.last_activity_ms
    }

    /// Feed one frame's RMS level (linear, 0.0–1.0). Frames of 20–100 ms work.
    pub fn feed_rms(&mut self, now_ms: u64, rms: f32) {
        let db = if rms > 0.0 && rms.is_finite() {
            (20.0 * log10(rms)).max(SILENCE_DBFS)
        } else {
            SILENCE_DBFS
        };
        self.feed_dbfs(now_ms, db);
    }

    /// Convenience for callers holding PCM samples in −1.0..=1.0.
    pub fn feed_samples(&mut self, now_ms: u64, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        self.feed_rms(now_ms, sqrt(sum / samples.len() as f32));
    }

    pub fn feed_dbfs(&mut self, now_ms: u64, db: f32) {
        if self.stopped.is_some() || self.paused_since_ms.is_some() {
            return;
        }
        let second = now_ms / 1_000;
        let slot = (second % FLOOR_BUCKETS as u64) as usize;
        match self.bucket_second {
            Some(prev) if prev == second => {}
            Some(prev) if second > prev => {
                // Clear every bucket skipped since the last frame.
                let gap = (second - prev).min(FLOOR_BUCKETS as u64);
                for k in 1..=gap {
                    self.buckets[((prev + k) % FLOOR_BUCKETS as u64) as usize] = f32::INFINITY;
                }
                self.bucket_second = Some(second);
            }
            _ => {
                self.buckets = [f32::INFINITY; FLOOR_BUCKETS];
                self.bucket_second = Some(second);
            }
        }
        self.buckets[slot] = self.buckets[slot].min(db);
        let floor = self.noise_floor_dbfs().unwrap_or(db);
        let threshold = (floor + self.cfg.activity_margin_db).max(self.cfg.min_activity_dbfs);
        let above = db > threshold;

        if above {
            let since = *self.active_since_ms.get_or_insert(now_ms);
            if now_ms.saturating_sub(since) >= self.cfg.min_activity_ms {
                self.last_activity_ms = now_ms;
            }
        } else {
            self.active_since_ms = None;
        }
    }

    pub fn signal(&mut self, now_ms: u64, signal: Signal) {
        if self.stopped.is_some() {
            return;
        }
        match signal {
            Signal::UserStop => self.stopped = Some(StopReason::UserStopped),
            Signal::MeetingEnded => self.stopped = Some(StopReason::MeetingEnded),
            Signal::TabClosed => self.stopped = Some(StopReason::TabClosed),
            Signal::WindowClosed => self.stopped = Some(StopReason::WindowClosed),
            Signal::NavigatedAway => self.start_soft(now_ms, StopReason::MeetingEnded),
            Signal::DeviceLost => self.start_soft(now_ms, StopReason::DeviceLost),
            Signal::Returned => {
                if matches!(self.soft, Some((StopReason::MeetingEnded, _))) {
                    self.soft = None;
                }
            }
            Signal::DeviceRestored => {
                if matches!(self.soft, Some((StopReason::DeviceLost, _))) {
                    self.soft = None;
                }
            }
            Signal::KeepRecording => self.last_activity_ms = now_ms,
            Signal::Pause => {
                self.paused_since_ms.get_or_insert(now_ms);
            }
            Signal::Resume => {
                if self.paused_since_ms.take().is_some() {
                    // A pause is a deliberate choice, not inactivity.
                    self.last_activity_ms = now_ms;
                    self.active_since_ms = None;
                    self.bucket_second = None;
                }
            }
        }
    }

    fn start_soft(&mut self, now_ms: u64, reason: StopReason) {
        if self.soft.is_none() {
            self.soft = Some((reason, now_ms + self.cfg.soft_signal_grace_ms));
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused_since_ms.is_some()
    }

    pub fn tick(&mut self, now_ms: u64) -> Decision {
        if let Some(reason) = self.stopped {
            return Decision::Stop { reason };
        }
        let hard_stop = self.started_ms + self.cfg.hard_max_ms;
        if now_ms >= hard_stop {
            return self.stop(StopReason::HardLimit);
        }
        if let Some((reason, deadline)) = self.soft {
            if now_ms >= deadline {
                return self.stop(reason);
            }
        }
        // Paused recordings cannot go idle, but the hard limit still applies.
        let idle_stop = if self.paused_since_ms.is_some() {
            None
        } else {
            let warn_at = self.last_activity_ms + self.cfg.idle_warning_after_ms;
            let stop_at = warn_at + self.cfg.idle_stop_after_warning_ms;
            if now_ms >= stop_at {
                return self.stop(StopReason::ProlongedInactivity);
            }
            (now_ms >= warn_at).then_some(stop_at)
        };

        // Report the warning whose stop comes first.
        let mut warn: Option<(WarnReason, u64)> = None;
        let mut consider = |reason, at: u64| {
            if warn.is_none_or(|(_, cur)| at < cur) {
                warn = Some((reason, at));
            }
        };
        if let Some(at) = idle_stop {
            consider(WarnReason::Inactivity, at);
        }
        if let Some((reason, deadline)) = self.soft {
            consider(WarnReason::SoftSignal(reason), deadline);
        }
        if now_ms + self.cfg.hard_max_warning_ms >= hard_stop {
            consider(WarnReason::HardLimitApproaching, hard_stop);
        }
        match warn {
            Some((reason, stop_at_ms)) => Decision::Warn { reason, stop_at_ms },
            None => Decision::Continue,
        }
    }

    fn stop(&mut self, reason: StopReason) -> Decision {
        self.stopped = Some(reason);
        Decision::Stop { reason }
    }
}

// Minimal no_std float helpers; accuracy well beyond what a level meter needs.

fn log10(x: f32) -> f32 {
    // log2 from the exponent bits plus a polynomial on the mantissa in [1, 2).
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
    let t = m - 1.0;
    let log2_m = t
        * (core::f32::consts::LOG2_E
            - t * (0.721_347_5 - t * (0.479_8 - t * (0.336_8 - t * 0.162))));
    (e as f32 + log2_m) * core::f32::consts::LOG10_2
}

fn sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fbd_1df5);
    for _ in 0..3 {
        y = 0.5 * (y + x / y);
    }
    y
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;
    const SPEECH: f32 = 0.1; // −20 dBFS
    const ROOM: f32 = 0.003; // ≈ −50 dBFS

    /// Speech-like input: 300 ms syllables with 150 ms gaps of room tone.
    const TALK: f32 = -1.0;

    fn run(d: &mut Detector, from: u64, to: u64, rms: f32) -> Option<Decision> {
        let mut t = from;
        while t < to {
            let level = if rms == TALK {
                if t % 450 < 300 {
                    SPEECH
                } else {
                    ROOM
                }
            } else {
                rms
            };
            d.feed_rms(t, level);
            if let s @ Decision::Stop { .. } = d.tick(t) {
                return Some(s);
            }
            t += 50;
        }
        None
    }

    #[test]
    fn math_helpers_are_close() {
        for (x, want) in [
            (1.0_f32, 0.0_f32),
            (0.1, -1.0),
            (0.5, -core::f32::consts::LOG10_2),
            (0.003, -2.5229),
        ] {
            assert!((log10(x) - want).abs() < 0.01, "log10({x})");
        }
        assert!((sqrt(2.0) - core::f32::consts::SQRT_2).abs() < 1e-5);
    }

    #[test]
    fn conversational_pauses_never_stop() {
        let mut d = Detector::new(Config::default(), 0);
        let mut t = 0;
        // An hour of: 20 s speech, then up to 5 minutes of total silence.
        for i in 0..12 {
            assert!(run(&mut d, t, t + 20_000, TALK).is_none());
            t += 20_000;
            let quiet = (i % 5 + 1) * MIN;
            assert!(run(&mut d, t, t + quiet, ROOM).is_none());
            assert!(!matches!(
                d.tick(t + quiet),
                Decision::Warn {
                    reason: WarnReason::Inactivity,
                    ..
                }
            ));
            t += quiet;
        }
    }

    #[test]
    fn prolonged_inactivity_warns_then_stops() {
        let cfg = Config::default();
        let mut d = Detector::new(cfg, 0);
        assert!(run(&mut d, 0, 10_000, TALK).is_none());
        assert!(run(&mut d, 10_000, 10_000 + 6 * MIN - 1_000, ROOM).is_none());
        assert_eq!(d.tick(10_000 + 6 * MIN - 1_000), Decision::Continue);
        let warn_at = d.last_activity_ms() + cfg.idle_warning_after_ms;
        match d.tick(warn_at) {
            Decision::Warn {
                reason: WarnReason::Inactivity,
                stop_at_ms,
            } => {
                assert_eq!(stop_at_ms, warn_at + cfg.idle_stop_after_warning_ms)
            }
            other => panic!("expected warning, got {other:?}"),
        }
        let stop = run(&mut d, 10_000 + 6 * MIN, 10_000 + 10 * MIN, ROOM);
        assert_eq!(
            stop,
            Some(Decision::Stop {
                reason: StopReason::ProlongedInactivity
            })
        );
    }

    #[test]
    fn speech_or_keep_recording_clears_the_warning() {
        let mut d = Detector::new(Config::default(), 0);
        run(&mut d, 0, 7 * MIN, ROOM);
        assert!(matches!(d.tick(7 * MIN), Decision::Warn { .. }));
        run(&mut d, 7 * MIN, 7 * MIN + 2_000, TALK);
        assert_eq!(d.tick(7 * MIN + 2_000), Decision::Continue);

        run(&mut d, 7 * MIN + 2_000, 14 * MIN, ROOM);
        assert!(matches!(d.tick(14 * MIN), Decision::Warn { .. }));
        d.signal(14 * MIN, Signal::KeepRecording);
        assert_eq!(d.tick(14 * MIN + 1), Decision::Continue);
    }

    #[test]
    fn clicks_do_not_count_as_activity() {
        let mut d = Detector::new(Config::default(), 0);
        let mut t = 0;
        while t < 10 * MIN {
            // 50 ms tap every 5 s, otherwise quiet.
            d.feed_rms(t, if t % 5_000 == 0 { SPEECH } else { ROOM });
            if let Decision::Stop { reason } = d.tick(t) {
                assert_eq!(reason, StopReason::ProlongedInactivity);
                return;
            }
            t += 50;
        }
        panic!("taps kept the recording alive");
    }

    #[test]
    fn constant_hum_is_absorbed_into_the_floor() {
        let mut d = Detector::new(Config::default(), 0);
        run(&mut d, 0, 30_000, ROOM);
        // A fan starts at −30 dBFS and never stops; no one speaks.
        let stop = run(&mut d, 30_000, 60 * MIN, 0.03);
        assert_eq!(
            stop,
            Some(Decision::Stop {
                reason: StopReason::ProlongedInactivity
            })
        );
    }

    #[test]
    fn hard_signals_stop_immediately() {
        for (signal, reason) in [
            (Signal::UserStop, StopReason::UserStopped),
            (Signal::MeetingEnded, StopReason::MeetingEnded),
            (Signal::TabClosed, StopReason::TabClosed),
            (Signal::WindowClosed, StopReason::WindowClosed),
        ] {
            let mut d = Detector::new(Config::default(), 0);
            d.signal(5, signal);
            assert_eq!(d.tick(5), Decision::Stop { reason });
            d.signal(6, Signal::KeepRecording);
            assert_eq!(d.tick(6), Decision::Stop { reason }, "stop is final");
        }
    }

    #[test]
    fn soft_signals_have_a_grace_period() {
        let cfg = Config::default();
        let mut d = Detector::new(cfg, 0);
        d.signal(1_000, Signal::NavigatedAway);
        assert_eq!(
            d.tick(2_000),
            Decision::Warn {
                reason: WarnReason::SoftSignal(StopReason::MeetingEnded),
                stop_at_ms: 1_000 + cfg.soft_signal_grace_ms
            }
        );
        d.signal(3_000, Signal::Returned);
        assert_eq!(d.tick(3_000), Decision::Continue);

        d.signal(4_000, Signal::DeviceLost);
        d.signal(4_500, Signal::Returned); // unrelated recovery must not clear it
        assert_eq!(
            d.tick(4_000 + cfg.soft_signal_grace_ms),
            Decision::Stop {
                reason: StopReason::DeviceLost
            }
        );
    }

    #[test]
    fn hard_limit_warns_then_stops_even_with_speech() {
        let cfg = Config {
            hard_max_ms: 20 * MIN,
            ..Config::default()
        };
        let mut d = Detector::new(cfg, 0);
        assert!(run(&mut d, 0, 15 * MIN - 50, TALK).is_none());
        assert_eq!(
            d.tick(15 * MIN),
            Decision::Warn {
                reason: WarnReason::HardLimitApproaching,
                stop_at_ms: 20 * MIN
            }
        );
        let stop = run(&mut d, 15 * MIN, 21 * MIN, TALK);
        assert_eq!(
            stop,
            Some(Decision::Stop {
                reason: StopReason::HardLimit
            })
        );
    }

    #[test]
    fn pause_suspends_idle_but_not_hard_limit() {
        let cfg = Config {
            hard_max_ms: 60 * MIN,
            ..Config::default()
        };
        let mut d = Detector::new(cfg, 0);
        d.signal(MIN, Signal::Pause);
        assert!(d.is_paused());
        assert_eq!(d.tick(30 * MIN), Decision::Continue);
        d.signal(30 * MIN, Signal::Resume);
        assert_eq!(d.tick(35 * MIN), Decision::Continue);
        d.signal(40 * MIN, Signal::Pause);
        assert_eq!(
            d.tick(60 * MIN),
            Decision::Stop {
                reason: StopReason::HardLimit
            }
        );
    }

    #[test]
    fn digital_silence_and_bad_values_are_safe() {
        let mut d = Detector::new(Config::default(), 0);
        for (i, v) in [0.0, -1.0, f32::NAN, f32::INFINITY].into_iter().enumerate() {
            d.feed_rms(i as u64 * 50, v);
        }
        d.feed_samples(500, &[]);
        d.feed_samples(550, &[0.5, -0.5]);
        assert_eq!(d.tick(600), Decision::Continue);
    }
}
