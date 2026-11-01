//! Audio device discovery and the choice of FFmpeg inputs per platform.
//!
//! Resolution is a pure function of (platform, user choice, devices found),
//! so every platform's rules are tested here even though only Linux capture
//! is exercised on real FFmpeg in CI.

use crate::ffmpeg::Input;
use cap_meeting_protocol::CaptureMode;
use serde::Serialize;
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Windows,
    Mac,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Mac
        } else {
            Platform::Linux
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// Value passed to FFmpeg (device name, or index on macOS).
    pub id: String,
    pub name: String,
    /// Captures what the computer plays (other people in the call).
    pub loopback: bool,
}

#[derive(Clone, Debug, Default)]
pub struct InputChoice {
    pub mode: CaptureMode,
    pub microphone_id: Option<String>,
    pub system_audio: bool,
    /// Screen area for video mode: x, y, width, height.
    pub screen: Option<(i32, i32, u32, u32)>,
    pub x11_display: Option<String>,
}

const WINDOWS_LOOPBACK_HINTS: &[&str] = &[
    "virtual-audio-capturer",
    "stereo mix",
    "cable output",
    "what u hear",
    "loopback",
];

/// `ffmpeg -list_devices true -f dshow -i dummy` (stderr).
pub fn parse_dshow(text: &str) -> Vec<AudioDevice> {
    let mut out = Vec::new();
    let mut in_audio_section = false;
    for line in text.lines() {
        if line.contains("DirectShow audio devices") {
            in_audio_section = true;
            continue;
        }
        if line.contains("DirectShow video devices") {
            in_audio_section = false;
            continue;
        }
        if line.contains("Alternative name") {
            continue;
        }
        let Some(start) = line.find('"') else {
            continue;
        };
        let Some(len) = line[start + 1..].find('"') else {
            continue;
        };
        let name = &line[start + 1..start + 1 + len];
        let tail = &line[start + 2 + len..];
        let is_audio = tail.contains("(audio)") || (in_audio_section && !tail.contains("(video)"));
        if is_audio && !name.is_empty() {
            let lower = name.to_lowercase();
            out.push(AudioDevice {
                id: name.to_owned(),
                name: name.to_owned(),
                loopback: WINDOWS_LOOPBACK_HINTS.iter().any(|h| lower.contains(h)),
            });
        }
    }
    out
}

/// `ffmpeg -f avfoundation -list_devices true -i ""` (stderr).
pub fn parse_avfoundation(text: &str) -> Vec<AudioDevice> {
    let mut out = Vec::new();
    let mut audio = false;
    for line in text.lines() {
        if line.contains("AVFoundation audio devices") {
            audio = true;
            continue;
        }
        if line.contains("AVFoundation video devices") {
            audio = false;
            continue;
        }
        if !audio {
            continue;
        }
        let Some(open) = line.rfind("] [") else {
            continue;
        };
        let rest = &line[open + 3..];
        let Some(close) = rest.find(']') else {
            continue;
        };
        let index = &rest[..close];
        let name = rest[close + 1..].trim();
        if index.chars().all(|c| c.is_ascii_digit()) && !name.is_empty() {
            out.push(AudioDevice {
                id: index.to_owned(),
                name: name.to_owned(),
                loopback: false,
            });
        }
    }
    out
}

/// `ffmpeg -hide_banner -sources pulse` (stdout).
pub fn parse_pulse_sources(text: &str) -> Vec<AudioDevice> {
    text.lines()
        .filter_map(|line| {
            // Device lines look like "* <id> [<description>]"; FFmpeg 6.1+
            // adds the media type after it: "... [<description>] (audio)".
            let line = line.trim_start_matches(['*', ' ']);
            let (id, rest) = line.split_once(" [")?;
            let (name, after) = rest.rsplit_once(']')?;
            let after = after.trim();
            if !(after.is_empty() || (after.starts_with('(') && after.ends_with(')'))) {
                return None;
            }
            let name = name.trim().to_owned();
            if id.is_empty() || id.contains(' ') {
                return None;
            }
            Some(AudioDevice {
                loopback: id.ends_with(".monitor"),
                id: id.to_owned(),
                name,
            })
        })
        .collect()
}

/// Asks FFmpeg which audio devices exist. An empty list means none were found
/// (or FFmpeg is missing); resolution then explains what to do.
pub fn list_audio_devices(ffmpeg: &str, platform: Platform) -> Vec<AudioDevice> {
    let run = |args: &[&str]| {
        Command::new(ffmpeg)
            .args(args)
            .output()
            .map(|o| {
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
            })
            .unwrap_or_default()
    };
    match platform {
        Platform::Windows => parse_dshow(&run(&[
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])),
        Platform::Mac => parse_avfoundation(&run(&[
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
        ])),
        Platform::Linux => parse_pulse_sources(&run(&["-hide_banner", "-sources", "pulse"])),
    }
}

/// Whether "include other people's audio" can work with these devices.
pub fn system_audio_available(platform: Platform, devices: &[AudioDevice]) -> bool {
    match platform {
        // PulseAudio/PipeWire always offer the default output's monitor.
        Platform::Linux => true,
        // WASAPI loopback; Session::start reports a missing output device.
        Platform::Windows => {
            let _ = devices;
            true
        }
        // Needs the ScreenCaptureKit helper, which is not verified yet.
        Platform::Mac => false,
    }
}

pub fn resolve_inputs(
    platform: Platform,
    choice: &InputChoice,
    devices: &[AudioDevice],
) -> Result<Vec<Input>, String> {
    let mut inputs = Vec::new();
    if choice.mode == CaptureMode::Video {
        let (x, y, width, height) = choice.screen.ok_or("Choose a screen to record.")?;
        match platform {
            Platform::Linux => inputs.push(Input::LinuxX11 {
                display: choice.x11_display.clone().unwrap_or_else(|| ":0".into()),
                x,
                y,
                width,
                height,
            }),
            Platform::Windows => inputs.push(Input::WindowsGdi { x, y, width, height }),
            Platform::Mac => {
                return Err("Video meeting mode is not available on macOS yet. Use audio mode or the screen recorder.".into())
            }
        }
    }
    let mics: Vec<&AudioDevice> = devices.iter().filter(|d| !d.loopback).collect();
    let chosen = choice
        .microphone_id
        .as_deref()
        .filter(|m| !m.trim().is_empty());
    match platform {
        Platform::Linux => {
            inputs.push(Input::LinuxPulse {
                source: chosen.unwrap_or("default").to_owned(),
            });
            if choice.system_audio {
                inputs.push(Input::LinuxMonitor);
            }
        }
        Platform::Windows => {
            let mic = match chosen {
                Some(id) => mics
                    .iter()
                    .find(|d| d.id == id)
                    .map(|d| d.id.clone())
                    .ok_or("That microphone is no longer connected. Choose another one.")?,
                None => mics
                    .first()
                    .map(|d| d.id.clone())
                    .ok_or("No microphone was found. Connect one, or allow Cap to use the microphone in Windows Privacy settings.")?,
            };
            inputs.push(Input::WindowsDshow { device: mic });
            if choice.system_audio {
                // Native loopback: no "Stereo Mix" or virtual driver needed.
                inputs.push(Input::WindowsLoopback);
            }
        }
        Platform::Mac => {
            if choice.system_audio {
                return Err("Recording the computer's sound is not available on macOS yet. Turn off \"Include other people's audio\".".into());
            }
            let mic = match chosen {
                Some(id) => id.to_owned(),
                None => mics
                    .first()
                    .map(|d| d.id.clone())
                    .unwrap_or_else(|| "0".into()),
            };
            inputs.push(Input::MacAvfoundation { device: mic });
        }
    }
    Ok(inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSHOW: &str = r#"[dshow @ 0000] "Integrated Camera" (video)
[dshow @ 0000]   Alternative name "@device_pnp_\\?\usb#vid"
[dshow @ 0000] "Microphone Array (Realtek(R) Audio)" (audio)
[dshow @ 0000]   Alternative name "@device_cm_{33D9A762}\wave_{A1}"
[dshow @ 0000] "Stereo Mix (Realtek(R) Audio)" (audio)
dummy: Immediate exit requested"#;

    const DSHOW_OLD: &str = r#"[dshow @ 01] DirectShow video devices (some may be both video and audio devices)
[dshow @ 01]  "USB Camera"
[dshow @ 01] DirectShow audio devices
[dshow @ 01]  "Headset Microphone (USB)"
[dshow @ 01]  "virtual-audio-capturer""#;

    const AVF: &str = r#"[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x1] [1] External USB Mic"#;

    const PULSE: &str = "Auto-detected sources for pulse:\n* alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo]\n  alsa_output.pci-0000_00_1f.3.analog-stereo.monitor [Monitor of Built-in Audio Analog Stereo]\n";

    #[test]
    fn parses_device_lists() {
        let d = parse_dshow(DSHOW);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].name, "Microphone Array (Realtek(R) Audio)");
        assert!(!d[0].loopback && d[1].loopback);
        let old = parse_dshow(DSHOW_OLD);
        assert_eq!(
            old.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["Headset Microphone (USB)", "virtual-audio-capturer"]
        );
        assert!(old[1].loopback);
        let mac = parse_avfoundation(AVF);
        assert_eq!(
            mac.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["0", "1"]
        );
        assert_eq!(mac[1].name, "External USB Mic");
        let pulse = parse_pulse_sources(PULSE);
        assert_eq!(pulse.len(), 2);
        assert!(!pulse[0].loopback && pulse[1].loopback);
        // FFmpeg 6.1+ (Ubuntu 24.04) appends the media type.
        let newer = parse_pulse_sources(
            "Auto-detected sources for pulse:\n* alsa_input.usb-mic.analog-stereo [USB Mic] (audio)\n  speakers.monitor [Monitor of Null Output] (none)\n",
        );
        assert_eq!(newer.len(), 2, "{newer:?}");
        assert_eq!(newer[0].name, "USB Mic");
        assert!(!newer[0].loopback && newer[1].loopback);
    }

    fn audio(system: bool, mic: Option<&str>) -> InputChoice {
        InputChoice {
            system_audio: system,
            microphone_id: mic.map(str::to_owned),
            ..InputChoice::default()
        }
    }

    #[test]
    fn windows_records_the_first_microphone_plus_native_loopback() {
        let devs = parse_dshow(DSHOW);
        let mic = Input::WindowsDshow {
            device: "Microphone Array (Realtek(R) Audio)".into(),
        };
        assert_eq!(
            resolve_inputs(Platform::Windows, &audio(true, None), &devs).unwrap(),
            vec![mic.clone(), Input::WindowsLoopback]
        );
        // No "Stereo Mix" needed any more.
        let mic_only: Vec<_> = devs.iter().filter(|d| !d.loopback).cloned().collect();
        assert!(system_audio_available(Platform::Windows, &mic_only));
        assert_eq!(
            resolve_inputs(Platform::Windows, &audio(true, None), &mic_only).unwrap(),
            vec![mic.clone(), Input::WindowsLoopback]
        );
        assert_eq!(
            resolve_inputs(Platform::Windows, &audio(false, None), &mic_only).unwrap(),
            vec![mic]
        );
        assert!(resolve_inputs(Platform::Windows, &audio(false, None), &[])
            .unwrap_err()
            .contains("No microphone"));
        assert!(resolve_inputs(Platform::Windows, &audio(false, Some("Gone Mic")), &devs).is_err());
        // A loopback device is never picked as the microphone.
        let only_loopback: Vec<_> = devs.iter().filter(|d| d.loopback).cloned().collect();
        assert!(resolve_inputs(Platform::Windows, &audio(false, None), &only_loopback).is_err());
    }

    #[test]
    fn linux_and_mac_rules() {
        assert_eq!(
            resolve_inputs(Platform::Linux, &audio(true, None), &[]).unwrap(),
            vec![
                Input::LinuxPulse {
                    source: "default".into()
                },
                Input::LinuxMonitor
            ]
        );
        assert!(system_audio_available(Platform::Linux, &[]));
        let mac = parse_avfoundation(AVF);
        assert_eq!(
            resolve_inputs(Platform::Mac, &audio(false, Some("1")), &mac).unwrap(),
            vec![Input::MacAvfoundation { device: "1".into() }]
        );
        assert!(!system_audio_available(Platform::Mac, &mac));
        assert!(resolve_inputs(Platform::Mac, &audio(true, None), &mac).is_err());
        let video = InputChoice {
            mode: CaptureMode::Video,
            screen: Some((0, 0, 1280, 720)),
            ..InputChoice::default()
        };
        assert!(resolve_inputs(Platform::Mac, &video, &mac).is_err());
        assert!(matches!(
            resolve_inputs(Platform::Windows, &video, &parse_dshow(DSHOW)).unwrap()[0],
            Input::WindowsGdi { .. }
        ));
        let no_screen = InputChoice {
            mode: CaptureMode::Video,
            ..InputChoice::default()
        };
        assert!(resolve_inputs(Platform::Linux, &no_screen, &[]).is_err());
    }
}
