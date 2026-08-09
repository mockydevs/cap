use crate::model::{Capabilities, CaptureOptions, CaptureSource, SourceKind};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
};
use xcap::{Monitor, Window};

pub fn capabilities() -> Result<Capabilities, String> {
    let mut sources = Vec::new();
    for monitor in Monitor::all().map_err(|e| e.to_string())? {
        sources.push(CaptureSource {
            id: format!(
                "monitor:{}:{}:{}:{}:{}",
                monitor.id(),
                monitor.x(),
                monitor.y(),
                monitor.width(),
                monitor.height()
            ),
            name: monitor.name().to_string(),
            kind: SourceKind::Monitor,
        });
    }
    for window in Window::all().map_err(|e| e.to_string())? {
        if window.is_minimized() || window.title().trim().is_empty() {
            continue;
        }
        #[cfg(not(target_os = "macos"))]
        sources.push(CaptureSource {
            id: format!(
                "window:{}:{}:{}:{}:{}",
                window.id(),
                window.x(),
                window.y(),
                window.width(),
                window.height()
            ),
            name: window.title().to_string(),
            kind: SourceKind::Window,
        });
    }
    let (platform, permission_guidance) = platform_guidance();
    Ok(Capabilities {
        platform: platform.into(),
        permission_guidance,
        sources,
    })
}

fn platform_guidance() -> (&'static str, Vec<String>) {
    #[cfg(target_os = "windows")]
    return (
        "windows",
        vec!["Allow microphone and camera access in Windows Privacy & security settings.".into()],
    );
    #[cfg(target_os = "macos")]
    return ("macos", vec!["Enable Screen Recording, Microphone, and Camera for Cap in System Settings → Privacy & Security, then restart Cap.".into()]);
    #[cfg(target_os = "linux")]
    return ("linux", vec!["Wayland capture requires PipeWire and xdg-desktop-portal; X11 capture requires DISPLAY. PulseAudio/PipeWire supplies audio.".into()]);
    #[allow(unreachable_code)]
    (
        "unsupported",
        vec!["This operating system is not supported.".into()],
    )
}

fn source_geometry(id: &str) -> Result<(i32, i32, u32, u32), String> {
    let values: Vec<_> = id.split(':').collect();
    if values.len() != 6 || (values[0] != "monitor" && values[0] != "window") {
        return Err("Invalid capture source".into());
    }
    Ok((
        values[2].parse().map_err(|_| "Invalid monitor x")?,
        values[3].parse().map_err(|_| "Invalid monitor y")?,
        values[4].parse().map_err(|_| "Invalid monitor width")?,
        values[5].parse().map_err(|_| "Invalid monitor height")?,
    ))
}

pub fn spawn(options: &CaptureOptions, output: &Path) -> Result<Child, String> {
    if !(1..=60).contains(&options.frame_rate) || !(1..=51).contains(&options.quality) {
        return Err("Frame rate or quality is outside its safe range".into());
    }
    let (mut x, mut y, mut width, mut height) = source_geometry(&options.video_source_id)?;
    if let Some(region) = &options.region {
        x += region.x;
        y += region.y;
        width = region.width;
        height = region.height;
    }
    width = width.min(options.width).max(2) & !1;
    height = height.min(options.height).max(2) & !1;
    let mut command = Command::new("ffmpeg");
    command.arg("-hide_banner").arg("-nostdin").arg("-y");
    platform_input(&mut command, x, y, width, height, options)?;
    command.args([
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        &options.quality.to_string(),
        "-pix_fmt",
        "yuv420p",
        "-r",
        &options.frame_rate.to_string(),
    ]);
    if options.microphone_id.is_some() || options.system_audio {
        command.args(["-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"]);
    } else {
        command.arg("-an");
    }
    command.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        output.to_string_lossy().as_ref(),
    ]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("Could not launch FFmpeg: {e}. Install the bundled Cap media runtime.")
        })
}

#[cfg(target_os = "windows")]
fn platform_input(
    c: &mut Command,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    o: &CaptureOptions,
) -> Result<(), String> {
    c.args([
        "-f",
        "gdigrab",
        "-framerate",
        &o.frame_rate.to_string(),
        "-offset_x",
        &x.to_string(),
        "-offset_y",
        &y.to_string(),
        "-video_size",
        &format!("{w}x{h}"),
        "-draw_mouse",
        if o.cursor { "1" } else { "0" },
        "-i",
        "desktop",
    ]);
    if let Some(mic) = &o.microphone_id {
        c.args(["-f", "dshow", "-i", &format!("audio={mic}")]);
    } else if o.system_audio {
        c.args(["-f", "dshow", "-i", "audio=virtual-audio-capturer"]);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_input(
    c: &mut Command,
    _x: i32,
    _y: i32,
    _w: u32,
    _h: u32,
    o: &CaptureOptions,
) -> Result<(), String> {
    let index = o
        .video_source_id
        .split(':')
        .nth(1)
        .ok_or("Invalid display")?;
    c.args([
        "-f",
        "avfoundation",
        "-capture_cursor",
        if o.cursor { "1" } else { "0" },
        "-framerate",
        &o.frame_rate.to_string(),
        "-i",
        &format!("{index}:none"),
    ]);
    if let Some(mic) = &o.microphone_id {
        c.args(["-f", "avfoundation", "-i", &format!("none:{mic}")]);
    } else if o.system_audio {
        return Err("macOS system audio requires the ScreenCaptureKit build; select a microphone or disable system audio".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn platform_input(
    c: &mut Command,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    o: &CaptureOptions,
) -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none() {
        return Err(
            "Wayland requires an xdg-desktop-portal PipeWire stream; start Cap with portal access"
                .into(),
        );
    }
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".into());
    c.args([
        "-f",
        "x11grab",
        "-draw_mouse",
        if o.cursor { "1" } else { "0" },
        "-framerate",
        &o.frame_rate.to_string(),
        "-video_size",
        &format!("{w}x{h}"),
        "-i",
        &format!("{display}+{x},{y}"),
    ]);
    if let Some(mic) = &o.microphone_id {
        c.args(["-f", "pulse", "-i", mic]);
    } else if o.system_audio {
        c.args(["-f", "pulse", "-i", "@DEFAULT_MONITOR@"]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_monitor_geometry() {
        assert_eq!(
            source_geometry("monitor:7:-1920:0:1920:1080").unwrap(),
            (-1920, 0, 1920, 1080)
        );
    }
    #[test]
    fn rejects_caller_paths_as_sources() {
        assert!(source_geometry("../../secret").is_err());
    }
}
