//! FFmpeg command lines for meeting capture.
//!
//! One FFmpeg process writes standalone 30-second segments (each a complete
//! file, so a crash loses at most the segment being written) and, at the same
//! time, a 16 kHz mono PCM copy on stdout for the activity detector.

use cap_meeting_protocol::CaptureMode;
use std::path::Path;

pub const SEGMENT_SECONDS: u32 = 30;
pub const PCM_RATE: u32 = 16_000;

/// Where audio (and, for video, the picture) comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// PulseAudio/PipeWire source name (`default`, or a device).
    LinuxPulse { source: String },
    /// PulseAudio/PipeWire monitor of the default output: what the user hears.
    LinuxMonitor,
    /// DirectShow audio device (`audio=<name>`).
    WindowsDshow { device: String },
    /// AVFoundation audio device index or name (`:0`).
    MacAvfoundation { device: String },
    /// Raw f32le 48 kHz stereo from a pipe (the macOS ScreenCaptureKit
    /// helper, or Windows loopback once it is running).
    PcmPipe { path: String },
    /// The computer's own sound on Windows via WASAPI loopback. The session
    /// starts the capture and swaps this for a [`Input::PcmPipe`].
    WindowsLoopback,
    /// X11 screen area for video mode.
    LinuxX11 {
        display: String,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    /// Windows desktop area for video mode.
    WindowsGdi {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    /// Synthetic moving test pattern, for tests only.
    SyntheticVideo { seconds: u32 },
    /// Synthetic speech-like tone with pauses (or silence), for tests only.
    Synthetic { seconds: u32, silent: bool },
}

impl Input {
    fn is_video(&self) -> bool {
        matches!(
            self,
            Input::LinuxX11 { .. } | Input::WindowsGdi { .. } | Input::SyntheticVideo { .. }
        )
    }

    fn args(&self) -> Vec<String> {
        let v = |s: &[&str]| s.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        match self {
            Input::LinuxPulse { source } => v(&["-f", "pulse", "-i", source]),
            Input::LinuxMonitor => v(&["-f", "pulse", "-i", "@DEFAULT_MONITOR@"]),
            Input::WindowsDshow { device } => vec![
                "-f".into(),
                "dshow".into(),
                "-i".into(),
                format!("audio={device}"),
            ],
            Input::MacAvfoundation { device } => vec![
                "-f".into(),
                "avfoundation".into(),
                "-i".into(),
                format!("none:{device}"),
            ],
            // The format is given, so no probing: FFmpeg 8 otherwise reads
            // seconds of the pipe first, holding back the whole recording,
            // and the final seconds are lost at stop.
            Input::PcmPipe { path } => v(&[
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-thread_queue_size",
                "1024",
                "-f",
                "f32le",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-i",
            ])
            .into_iter()
            .chain([path.clone()])
            .collect(),
            // Replaced before FFmpeg starts; silence keeps the mix valid if not.
            Input::WindowsLoopback => v(&["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
            Input::LinuxX11 {
                display,
                x,
                y,
                width,
                height,
            } => vec![
                "-f".into(),
                "x11grab".into(),
                "-framerate".into(),
                "15".into(),
                "-video_size".into(),
                format!("{}x{}", width & !1, height & !1),
                "-i".into(),
                format!("{display}+{x},{y}"),
            ],
            Input::WindowsGdi {
                x,
                y,
                width,
                height,
            } => vec![
                "-f".into(),
                "gdigrab".into(),
                "-framerate".into(),
                "15".into(),
                "-offset_x".into(),
                x.to_string(),
                "-offset_y".into(),
                y.to_string(),
                "-video_size".into(),
                format!("{}x{}", width & !1, height & !1),
                "-i".into(),
                "desktop".into(),
            ],
            // Two seconds of "speech" (amplitude-modulated tone), one second
            // pause, repeated: enough structure for the activity detector.
            Input::SyntheticVideo { seconds } => vec![
                "-re".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("testsrc=size=320x240:rate=15:duration={seconds}"),
            ],
            Input::Synthetic { seconds, silent } => vec![
                "-re".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                if *silent {
                    format!("anullsrc=r=48000:cl=mono:d={seconds}")
                } else {
                    format!("sine=frequency=220:sample_rate=48000:duration={seconds},volume='if(lt(mod(t,3),2),0.5,0)':eval=frame")
                },
            ],
        }
    }
}

/// Full argument list (without the `ffmpeg` program name).
pub fn args(inputs: &[Input], mode: CaptureMode, dir: &Path, segment_seconds: u32) -> Vec<String> {
    args_aligned(inputs, mode, dir, segment_seconds, None)
}

/// Whether live Linux inputs should be aligned on wall-clock time: more than
/// one input, all of them PulseAudio or (in video mode) X11 screen capture,
/// which all carry wall-clock timestamps.
pub fn wants_alignment(inputs: &[Input], mode: CaptureMode) -> bool {
    inputs.len() > 1
        && inputs.iter().all(|i| match i {
            Input::LinuxPulse { .. } | Input::LinuxMonitor => true,
            Input::LinuxX11 { .. } => mode == CaptureMode::Video,
            _ => false,
        })
}

/// Like [`args`]; with `origin` (Unix seconds, taken just before FFmpeg
/// starts) PulseAudio inputs keep their wall-clock timestamps and are each
/// shifted to that origin and padded with silence until their stream starts.
/// Otherwise the mixer pairs samples by count: a microphone stream that
/// starts 2 s after the speakers' monitor ended up 2 s late in the mix, and
/// its last 2 s before Stop were cut.
pub fn args_aligned(
    inputs: &[Input],
    mode: CaptureMode,
    dir: &Path,
    segment_seconds: u32,
    origin: Option<f64>,
) -> Vec<String> {
    let mut out: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // FFmpeg 7+ reads the "q" sent at Stop only once per stats period
        // (0.5 s by default), so it kept recording up to 0.5 s after Stop.
        "-stats_period".into(),
        "0.05".into(),
        "-y".into(),
    ];
    if origin.is_some() {
        out.push("-copyts".into());
    }
    for input in inputs {
        out.extend(input.args());
    }
    let audio: Vec<usize> = inputs
        .iter()
        .enumerate()
        .filter(|(_, i)| !i.is_video())
        .map(|(n, _)| n)
        .collect();
    let video = inputs
        .iter()
        .position(Input::is_video)
        .filter(|_| mode == CaptureMode::Video);
    let mix = if let Some(origin) = origin {
        // Every stream shifted to the same origin; audio padded with silence
        // until its stream starts, so all inputs stay in sync.
        let mut graph = String::new();
        if let Some(v) = video {
            graph.push_str(&format!("[{v}:v]setpts=PTS-{origin:.6}/TB[vid];"));
        }
        for n in &audio {
            graph.push_str(&format!(
                "[{n}:a]asetpts=PTS-{origin:.6}/TB,aresample=async=1:first_pts=0[a{n}];"
            ));
        }
        let labels: String = audio.iter().map(|n| format!("[a{n}]")).collect();
        if audio.len() > 1 {
            format!(
                "{graph}{labels}amix=inputs={}:duration=longest:normalize=0,asplit=2[rec][vad]",
                audio.len()
            )
        } else {
            format!("{graph}{labels}asplit=2[rec][vad]")
        }
    } else if audio.len() > 1 {
        let labels: String = audio.iter().map(|n| format!("[{n}:a]")).collect();
        format!(
            "{labels}amix=inputs={}:duration=longest:normalize=0,asplit=2[rec][vad]",
            audio.len()
        )
    } else {
        format!(
            "[{}:a]asplit=2[rec][vad]",
            audio.first().copied().unwrap_or(0)
        )
    };
    out.extend(["-filter_complex".into(), mix]);
    let ext = if video.is_some() { "webm" } else { "ogg" };
    if let Some(v) = video {
        out.extend([
            "-map".into(),
            if origin.is_some() {
                "[vid]".into()
            } else {
                format!("{v}:v")
            },
            "-c:v".into(),
            "libvpx".into(),
            "-deadline".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "8".into(),
            "-b:v".into(),
            "1500k".into(),
            "-force_key_frames".into(),
            format!("expr:gte(t,n_forced*{segment_seconds})"),
        ]);
    }
    // Each output is flushed packet by packet. Otherwise FFmpeg holds about
    // 2 s of captured audio in its output buffers, and "q" at stop drops it
    // (7 s of PulseAudio became 5 s). Stop still cuts capture immediately.
    out.extend([
        "-map".into(),
        "[rec]".into(),
        "-c:a".into(),
        "libopus".into(),
        "-b:a".into(),
        "48k".into(),
        "-f".into(),
        "segment".into(),
        "-segment_time".into(),
        segment_seconds.to_string(),
        "-flush_packets".into(),
        "1".into(),
        "-segment_format".into(),
        if video.is_some() {
            "webm".into()
        } else {
            "ogg".into()
        },
        "-reset_timestamps".into(),
        "1".into(),
        "-segment_list".into(),
        dir.join("segments.csv").to_string_lossy().into_owned(),
        "-segment_list_type".into(),
        "csv".into(),
        dir.join(format!("seg_%06d.{ext}"))
            .to_string_lossy()
            .into_owned(),
        "-map".into(),
        "[vad]".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        PCM_RATE.to_string(),
        "-flush_packets".into(),
        "1".into(),
        "-f".into(),
        "s16le".into(),
        "pipe:1".into(),
    ]);
    out
}

/// A finished segment, as FFmpeg lists it once the file is closed.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub seq: u32,
    pub file: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Parses FFmpeg's CSV segment list (`file,start,end`). Lines are written only
/// after a segment is complete, so every listed segment is safe to upload.
pub fn parse_segment_list(csv: &str) -> Vec<Segment> {
    csv.lines()
        .filter_map(|line| {
            let mut parts = line.rsplitn(3, ',');
            let end: f64 = parts.next()?.trim().parse().ok()?;
            let start: f64 = parts.next()?.trim().parse().ok()?;
            let file = parts.next()?.trim().trim_matches('"').to_owned();
            let seq = file.strip_prefix("seg_")?.split('.').next()?.parse().ok()?;
            let ms = |s: f64| (s.max(0.0) * 1000.0).round() as u64;
            Some(Segment {
                seq,
                start_ms: ms(start),
                end_ms: ms(end).max(ms(start) + 1),
                file,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_mode_mixes_inputs_into_segments_and_pcm() {
        let a = args(
            &[
                Input::LinuxPulse {
                    source: "default".into(),
                },
                Input::LinuxMonitor,
            ],
            CaptureMode::Audio,
            Path::new("/m"),
            SEGMENT_SECONDS,
        );
        let joined = a.join(" ");
        assert!(joined.contains("[0:a][1:a]amix=inputs=2"));
        assert!(joined.contains("-segment_time 30"));
        // Native separators: the same paths are backslashed on Windows.
        let dir = Path::new("/m");
        let segments = dir.join("seg_%06d.ogg");
        let list = dir.join("segments.csv");
        assert!(joined.contains(&*segments.to_string_lossy()));
        assert!(joined.contains(&format!("-segment_list {}", list.to_string_lossy())));
        assert!(joined.ends_with("-flush_packets 1 -f s16le pipe:1"));
        assert!(joined.starts_with("-hide_banner -loglevel error -stats_period 0.05 -y"));
        assert_eq!(
            joined.matches("-flush_packets 1").count(),
            2,
            "both outputs"
        );
        assert!(!joined.contains("libvpx"));
    }

    #[test]
    fn video_mode_adds_the_screen_and_webm_segments() {
        let a = args(
            &[
                Input::LinuxX11 {
                    display: ":0".into(),
                    x: 0,
                    y: 0,
                    width: 1921,
                    height: 1080,
                },
                Input::LinuxMonitor,
            ],
            CaptureMode::Video,
            Path::new("/m"),
            SEGMENT_SECONDS,
        );
        let joined = a.join(" ");
        assert!(joined.contains("-video_size 1920x1080"));
        assert!(joined.contains("[1:a]asplit=2[rec][vad]"));
        assert!(joined.contains("-map 0:v -c:v libvpx"));
        assert!(joined.contains("seg_%06d.webm"));
    }

    #[test]
    fn audio_mode_ignores_a_video_input() {
        let a = args(
            &[
                Input::LinuxX11 {
                    display: ":0".into(),
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                },
                Input::LinuxMonitor,
            ],
            CaptureMode::Audio,
            Path::new("/m"),
            SEGMENT_SECONDS,
        );
        assert!(!a.join(" ").contains("libvpx"));
    }

    #[test]
    fn pulse_inputs_are_aligned_on_wall_clock_time() {
        let pulse = [
            Input::LinuxPulse {
                source: "default".into(),
            },
            Input::LinuxMonitor,
        ];
        assert!(wants_alignment(&pulse, CaptureMode::Audio));
        assert!(wants_alignment(&pulse, CaptureMode::Video));
        let screen = Input::LinuxX11 {
            display: ":0".into(),
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        };
        let video = [screen.clone(), pulse[0].clone(), pulse[1].clone()];
        assert!(wants_alignment(&video, CaptureMode::Video));
        assert!(!wants_alignment(&video, CaptureMode::Audio));
        let joined =
            args_aligned(&video, CaptureMode::Video, Path::new("/m"), 30, Some(5.0)).join(" ");
        assert!(
            joined.contains("[0:v]setpts=PTS-5.000000/TB[vid];"),
            "{joined}"
        );
        assert!(joined.contains("[a1][a2]amix=inputs=2"));
        assert!(joined.contains("-map [vid] -c:v libvpx"));
        // One microphone with the screen: aligned too (sound and picture in sync).
        let joined = args_aligned(
            &video[..2],
            CaptureMode::Video,
            Path::new("/m"),
            30,
            Some(5.0),
        )
        .join(" ");
        assert!(joined.contains("[a1]asplit=2[rec][vad]"), "{joined}");
        assert!(!wants_alignment(&pulse[..1], CaptureMode::Audio));
        assert!(!wants_alignment(
            &[
                Input::WindowsDshow {
                    device: "Mic".into()
                },
                Input::PcmPipe { path: "p".into() }
            ],
            CaptureMode::Audio
        ));
        let joined = args_aligned(
            &pulse,
            CaptureMode::Audio,
            Path::new("/m"),
            30,
            Some(1_800_000_000.25),
        )
        .join(" ");
        assert!(
            joined.contains("-y -copyts -f pulse -i default"),
            "{joined}"
        );
        assert!(joined
            .contains("[0:a]asetpts=PTS-1800000000.250000/TB,aresample=async=1:first_pts=0[a0];"));
        assert!(joined.contains("[a0][a1]amix=inputs=2"));
        // Without an origin nothing changes.
        assert!(!args(&pulse, CaptureMode::Audio, Path::new("/m"), 30)
            .join(" ")
            .contains("-copyts"));
    }

    #[test]
    fn segment_list_parsing() {
        let csv = "seg_000000.ogg,0.000000,30.004000\nseg_000001.ogg,30.004000,47.5\n\"seg_000002.ogg\",47.5,47.5\ngarbage\n";
        let s = parse_segment_list(csv);
        assert_eq!(s.len(), 3);
        assert_eq!(
            s[1],
            Segment {
                seq: 1,
                file: "seg_000001.ogg".into(),
                start_ms: 30_004,
                end_ms: 47_500
            }
        );
        assert_eq!(
            s[2].end_ms, 47_501,
            "zero-length segments still get a positive duration"
        );
    }
}
