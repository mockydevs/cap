//! The computer's own sound on Windows: what the other people in a call say.
//!
//! WASAPI loopback records whatever Windows plays on the default speakers or
//! headphones, with no "Stereo Mix" or virtual audio driver. The samples go
//! to FFmpeg as raw 48 kHz stereo f32 through a private named pipe, the same
//! way the macOS helper feeds FFmpeg.
//!
//! Loopback delivers nothing while nothing is playing, but FFmpeg needs an
//! unbroken stream to mix with the microphone, so [`Pacer`] fills gaps with
//! silence and keeps the stream in real time. If the output device goes away
//! (headphones unplugged), recording carries on with silence for that side
//! and Cap reconnects to the new default device.

use std::time::{Duration, Instant};

pub const RATE: u64 = 48_000;
pub const CHANNELS: u64 = 2;
/// One f32 stereo frame.
pub const FRAME_BYTES: usize = 8;

/// Captured audio may run this far ahead of the wall clock before excess is
/// dropped (clock drift between the sound card and the system clock).
const MAX_AHEAD_FRAMES: u64 = RATE / 2;
/// Silence is added only after the device has delivered nothing this long,
/// so a late packet during speech is never padded over.
const IDLE_BEFORE_SILENCE: Duration = Duration::from_millis(60);
/// If the reader stalled (FFmpeg paused or the system froze) for longer than
/// this, the missed time is skipped instead of being filled with silence.
const MAX_CATCH_UP_FRAMES: u64 = RATE * 2;

/// What to write this tick: the first `keep` captured frames, then
/// `silence` frames of silence.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub keep: u64,
    pub silence: u64,
}

/// Keeps the raw stream at exactly [`RATE`] frames per wall-clock second.
pub struct Pacer {
    start: Instant,
    written: u64,
    last_data: Instant,
}

impl Pacer {
    pub fn new(start: Instant) -> Self {
        Self {
            start,
            written: 0,
            last_data: start,
        }
    }

    pub fn plan(&mut self, now: Instant, captured: u64) -> Plan {
        let expected =
            (now.saturating_duration_since(self.start).as_micros() as u64) * RATE / 1_000_000;
        if captured > 0 {
            self.last_data = now;
        }
        if expected.saturating_sub(self.written) > MAX_CATCH_UP_FRAMES {
            self.written = expected;
        }
        let keep = captured.min((expected + MAX_AHEAD_FRAMES).saturating_sub(self.written));
        self.written += keep;
        let silence = if captured == 0
            && now.saturating_duration_since(self.last_data) >= IDLE_BEFORE_SILENCE
        {
            expected.saturating_sub(self.written)
        } else {
            0
        };
        self.written += silence;
        Plan { keep, silence }
    }
}

#[cfg(windows)]
pub use windows_loopback::Loopback;

/// Placeholder elsewhere: system audio is recorded through PulseAudio on
/// Linux, and macOS has its own helper.
#[cfg(not(windows))]
pub struct Loopback;

#[cfg(not(windows))]
impl Loopback {
    pub fn start() -> Result<Self, String> {
        Err("Recording the computer's sound this way needs Windows.".into())
    }
    pub fn path(&self) -> &str {
        ""
    }
    pub fn stop(&mut self) {}
}

// Named pipes have no safe std API, so this module calls Win32 directly.
// The unsafe calls are limited to creating, connecting, writing and closing
// one pipe handle that this module owns.
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows_loopback {
    use super::{Pacer, FRAME_BYTES};
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread::JoinHandle,
        time::{Duration, Instant},
    };
    use wasapi::{Direction, SampleType, StreamMode, WaveFormat};
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, GENERIC_READ, HANDLE,
            INVALID_HANDLE_VALUE,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
            TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING,
            PIPE_ACCESS_OUTBOUND,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                PIPE_WAIT,
            },
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    const TICK: Duration = Duration::from_millis(10);
    const RECONNECT_EVERY: Duration = Duration::from_secs(2);

    struct Pipe(HANDLE);
    // The handle is used by one thread at a time: created here, then moved
    // into the writer thread.
    unsafe impl Send for Pipe {}
    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// Only this Windows user (and SYSTEM) may open the pipe: it carries
    /// meeting audio. The default security would let other users read it.
    struct PipeSecurity(PSECURITY_DESCRIPTOR);

    impl PipeSecurity {
        fn current_user() -> Result<Self, String> {
            let err = || "Could not secure system audio recording.".to_owned();
            unsafe {
                let mut token: HANDLE = std::ptr::null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(err());
                }
                let mut len = 0u32;
                GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
                // u64 storage keeps TOKEN_USER (pointers inside) aligned.
                let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
                let ok =
                    GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
                CloseHandle(token);
                if ok == 0 {
                    return Err(err());
                }
                let user = &*(buf.as_ptr() as *const TOKEN_USER);
                let mut sid_text: *mut u16 = std::ptr::null_mut();
                if ConvertSidToStringSidW(user.User.Sid, &mut sid_text) == 0 {
                    return Err(err());
                }
                let mut n = 0;
                while *sid_text.add(n) != 0 {
                    n += 1;
                }
                let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, n));
                LocalFree(sid_text.cast());
                // Protected DACL: full access for this user and SYSTEM only.
                let sddl = wide(&format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)"));
                let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
                if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(err());
                }
                Ok(Self(descriptor))
            }
        }

        fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0,
                bInheritHandle: 0,
            }
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0.cast()) };
        }
    }

    /// A running loopback capture. FFmpeg reads it from [`Loopback::path`].
    pub struct Loopback {
        path: String,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Loopback {
        pub fn start() -> Result<Self, String> {
            // Fail before recording starts if there is nothing to record from.
            let _ = wasapi::initialize_mta();
            wasapi::DeviceEnumerator::new()
                .and_then(|e| e.get_default_device(&Direction::Render))
                .map_err(|_| {
                    "Windows has no speaker or headphone device, so other people's audio cannot be recorded. Connect one, or turn off \"Include other people's audio\"."
                        .to_owned()
                })?;
            Self::start_pipe()
        }

        /// The pipe and writer without the device check (tests on machines
        /// with no sound device still exercise the pipe and the silence fill).
        pub(super) fn start_pipe() -> Result<Self, String> {
            let path = format!(r"\\.\pipe\cap-loopback-{}", uuid::Uuid::new_v4().simple());
            let name = wide(&path);
            let security = PipeSecurity::current_user()?;
            let attributes = security.attributes();
            // One instance, this machine only, this user only.
            let handle = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    1 << 20,
                    0,
                    0,
                    &attributes,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err("Could not prepare system audio recording.".into());
            }
            let pipe = Pipe(handle);
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let thread = std::thread::Builder::new()
                .name("cap-loopback".into())
                .spawn(move || run(pipe, flag))
                .map_err(|e| e.to_string())?;
            Ok(Self {
                path,
                stop,
                thread: Some(thread),
            })
        }

        pub fn path(&self) -> &str {
            &self.path
        }

        /// Stops capture. Safe to call twice and when FFmpeg never connected;
        /// never waits more than about two seconds.
        pub fn stop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let Some(thread) = self.thread.take() else {
                return;
            };
            // If FFmpeg never opened the pipe, the writer is still waiting
            // for a reader: open it ourselves (as a reader, since the pipe is
            // outbound) so it wakes up, sees the stop flag and exits.
            let name = wide(&self.path);
            let deadline = Instant::now() + Duration::from_secs(2);
            while !thread.is_finished() && Instant::now() < deadline {
                let h = unsafe {
                    CreateFileW(
                        name.as_ptr(),
                        GENERIC_READ,
                        0,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if h != INVALID_HANDLE_VALUE {
                    unsafe { CloseHandle(h) };
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
            // Otherwise the writer is blocked on a stuck reader; it exits when
            // that reader closes. Stopping a recording must never hang.
        }
    }

    impl Drop for Loopback {
        fn drop(&mut self) {
            self.stop();
        }
    }

    struct Capture {
        _client: wasapi::AudioClient,
        capture: wasapi::AudioCaptureClient,
    }

    impl Capture {
        fn open() -> Result<Self, wasapi::WasapiError> {
            let device = wasapi::DeviceEnumerator::new()?.get_default_device(&Direction::Render)?;
            let mut client = device.get_iaudioclient()?;
            let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
            // Polling, not events: event callbacks are unreliable for
            // loopback streams on some Windows versions.
            client.initialize_client(
                &format,
                &Direction::Capture,
                &StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns: 2_000_000,
                },
            )?;
            let capture = client.get_audiocaptureclient()?;
            client.start_stream()?;
            Ok(Self {
                _client: client,
                capture,
            })
        }

        fn drain(&self, out: &mut Vec<u8>) -> Result<(), wasapi::WasapiError> {
            while self.capture.get_next_packet_size()?.unwrap_or(0) > 0 {
                let mut data = VecDeque::new();
                let info = self.capture.read_from_device_to_deque(&mut data)?;
                if info.flags.silent {
                    out.resize(out.len() + data.len(), 0);
                } else {
                    out.extend(data);
                }
            }
            Ok(())
        }
    }

    fn write_all(pipe: &Pipe, mut bytes: &[u8]) -> bool {
        while !bytes.is_empty() {
            let mut written = 0u32;
            let chunk = bytes.len().min(1 << 20) as u32;
            let ok = unsafe {
                WriteFile(
                    pipe.0,
                    bytes.as_ptr(),
                    chunk,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || written == 0 {
                return false; // FFmpeg closed its end: recording is over.
            }
            bytes = &bytes[written as usize..];
        }
        true
    }

    fn run(pipe: Pipe, stop: Arc<AtomicBool>) {
        let connected = unsafe { ConnectNamedPipe(pipe.0, std::ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected || stop.load(Ordering::SeqCst) {
            return;
        }
        let _ = wasapi::initialize_mta();
        let mut pacer = Pacer::new(Instant::now());
        let mut capture: Option<Capture> = None;
        let mut last_attempt: Option<Instant> = None;
        let mut captured = Vec::new();
        let silence = vec![0u8; 48_000 * FRAME_BYTES / 10];
        while !stop.load(Ordering::SeqCst) {
            if capture.is_none() && last_attempt.is_none_or(|t| t.elapsed() >= RECONNECT_EVERY) {
                last_attempt = Some(Instant::now());
                capture = Capture::open().ok();
            }
            captured.clear();
            if let Some(c) = &capture {
                if c.drain(&mut captured).is_err() {
                    // Device unplugged or default changed: reconnect soon.
                    capture = None;
                }
            }
            let frames = (captured.len() / FRAME_BYTES) as u64;
            let plan = pacer.plan(Instant::now(), frames);
            if !write_all(&pipe, &captured[..plan.keep as usize * FRAME_BYTES]) {
                return;
            }
            let mut gap = plan.silence as usize * FRAME_BYTES;
            while gap > 0 {
                let n = gap.min(silence.len());
                if !write_all(&pipe, &silence[..n]) {
                    return;
                }
                gap -= n;
            }
            std::thread::sleep(TICK);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows only: FFmpeg's side of the pipe gets a real-time stream of
    /// silence when nothing is captured, and stop never hangs, whether or
    /// not a reader connected.
    /// The pipe's access list as SDDL, read through an open client handle.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    fn pipe_dacl(file: &std::fs::File) -> String {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                    SDDL_REVISION_1, SE_KERNEL_OBJECT,
                },
                DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            },
        };
        unsafe {
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetSecurityInfo(
                file.as_raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            );
            assert_eq!(rc, 0, "GetSecurityInfo failed");
            let mut text: *mut u16 = std::ptr::null_mut();
            let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            );
            assert_ne!(ok, 0);
            let mut n = 0;
            while *text.add(n) != 0 {
                n += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            LocalFree(text.cast());
            LocalFree(sd.cast());
            out
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_pipe_streams_silence_and_stops_cleanly() {
        use std::io::Read;
        let mut lb = windows_loopback::Loopback::start_pipe().unwrap();
        let mut reader = std::fs::File::open(lb.path()).unwrap();
        let dacl = pipe_dacl(&reader);
        // Protected, only this user and SYSTEM: no Everyone/anonymous entry.
        assert!(dacl.starts_with("D:P"), "{dacl}");
        assert_eq!(dacl.matches("(A;").count(), 2, "{dacl}");
        assert!(dacl.contains(";;;SY)"), "{dacl}");
        assert!(
            !dacl.contains(";;;WD)") && !dacl.contains(";;;AN)"),
            "{dacl}"
        );
        let mut buf = vec![0u8; RATE as usize * FRAME_BYTES / 2]; // 0.5 s
        let started = Instant::now();
        reader.read_exact(&mut buf).unwrap();
        // Paced in real time, not dumped instantly.
        assert!(
            started.elapsed() >= Duration::from_millis(350),
            "{:?}",
            started.elapsed()
        );
        let stop = Instant::now();
        drop(reader);
        lb.stop();
        assert!(stop.elapsed() < Duration::from_secs(2));

        // Never opened by FFmpeg: stop still returns promptly.
        let mut unused = windows_loopback::Loopback::start_pipe().unwrap();
        let stop = Instant::now();
        unused.stop();
        assert!(stop.elapsed() < Duration::from_secs(2));
    }

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn steady_audio_passes_through_untouched() {
        let s = Instant::now();
        let mut p = Pacer::new(s);
        for tick in 1..=100 {
            // 10 ms of audio every 10 ms.
            assert_eq!(
                p.plan(at(s, tick * 10), 480),
                Plan {
                    keep: 480,
                    silence: 0
                }
            );
        }
    }

    #[test]
    fn silence_fills_gaps_in_real_time_only_after_a_short_wait() {
        let s = Instant::now();
        let mut p = Pacer::new(s);
        // Nothing playing: no padding until the device has been idle 60 ms.
        assert_eq!(
            p.plan(at(s, 10), 0),
            Plan {
                keep: 0,
                silence: 0
            }
        );
        assert_eq!(
            p.plan(at(s, 50), 0),
            Plan {
                keep: 0,
                silence: 0
            }
        );
        assert_eq!(
            p.plan(at(s, 60), 0),
            Plan {
                keep: 0,
                silence: 2_880
            }
        );
        assert_eq!(
            p.plan(at(s, 1_060), 0),
            Plan {
                keep: 0,
                silence: 48_000
            }
        );
        // Sound starts again: it is written as is, with no padding.
        assert_eq!(
            p.plan(at(s, 1_070), 480),
            Plan {
                keep: 480,
                silence: 0
            }
        );
        // A late packet during speech is not padded over.
        assert_eq!(
            p.plan(at(s, 1_090), 0),
            Plan {
                keep: 0,
                silence: 0
            }
        );
    }

    #[test]
    fn a_long_stall_is_skipped_not_filled_with_silence() {
        let s = Instant::now();
        let mut p = Pacer::new(s);
        assert_eq!(
            p.plan(at(s, 10), 480),
            Plan {
                keep: 480,
                silence: 0
            }
        );
        // The reader was paused for 30 s: no 30 s of silence afterwards.
        assert_eq!(
            p.plan(at(s, 30_010), 480),
            Plan {
                keep: 480,
                silence: 0
            }
        );
        // Then normal gap filling resumes from the new position.
        assert_eq!(
            p.plan(at(s, 30_050), 0),
            Plan {
                keep: 0,
                silence: 0
            }
        );
        assert_eq!(
            p.plan(at(s, 30_100), 0),
            Plan {
                keep: 0,
                silence: 3_840
            }
        );
    }

    #[test]
    fn audio_far_ahead_of_the_clock_is_trimmed() {
        let s = Instant::now();
        let mut p = Pacer::new(s);
        // At 100 ms at most 4 800 + 24 000 frames may have been written.
        assert_eq!(
            p.plan(at(s, 100), 40_000),
            Plan {
                keep: 28_800,
                silence: 0
            }
        );
        assert_eq!(
            p.plan(at(s, 110), 480),
            Plan {
                keep: 480,
                silence: 0
            }
        );
    }
}
