use crate::model::{Capabilities, CaptureOptions, CaptureSource, SourceKind};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
};
use xcap::{Monitor, Window};

pub fn capabilities() -> Result<Capabilities, String> {
    let mut sources = Vec::new();
    // xcap 0.6's Monitor/Window accessors all return XCapResult<T>
    // (Result<T, XCapError>), not bare values — every call below is
    // fallibly unwrapped accordingly.
    for monitor in Monitor::all().map_err(|e| e.to_string())? {
        let id = monitor.id().map_err(|e| e.to_string())?;
        let x = monitor.x().map_err(|e| e.to_string())?;
        let y = monitor.y().map_err(|e| e.to_string())?;
        let width = monitor.width().map_err(|e| e.to_string())?;
        let height = monitor.height().map_err(|e| e.to_string())?;
        let name = monitor.name().map_err(|e| e.to_string())?;
        sources.push(CaptureSource {
            id: format!("monitor:{id}:{x}:{y}:{width}:{height}"),
            name,
            kind: SourceKind::Monitor,
        });
    }
    for window in Window::all().map_err(|e| e.to_string())? {
        let is_minimized = window.is_minimized().map_err(|e| e.to_string())?;
        let title = window.title().map_err(|e| e.to_string())?;
        if is_minimized || title.trim().is_empty() {
            continue;
        }
        #[cfg(not(target_os = "macos"))]
        {
            let id = window.id().map_err(|e| e.to_string())?;
            let x = window.x().map_err(|e| e.to_string())?;
            let y = window.y().map_err(|e| e.to_string())?;
            let width = window.width().map_err(|e| e.to_string())?;
            let height = window.height().map_err(|e| e.to_string())?;
            sources.push(CaptureSource {
                id: format!("window:{id}:{x}:{y}:{width}:{height}"),
                name: title,
                kind: SourceKind::Window,
            });
        }
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

/// Everything `spawn()` hands back to the caller so it can track and clean up
/// both the ffmpeg process and (macOS only, system-audio-without-microphone
/// only) the ScreenCaptureKit audio helper process spawned alongside it.
///
/// On Windows and Linux, and on macOS whenever a microphone is selected or
/// system audio is off, `system_audio_helper`/`system_audio_fifo` are always
/// `None` and this behaves exactly like the plain `Child` this function used
/// to return.
pub struct CaptureProcess {
    pub video: Child,
    pub system_audio_helper: Option<Child>,
    pub system_audio_fifo: Option<std::path::PathBuf>,
}

/// What a platform's `platform_input` implementation optionally spawns as a
/// second, independent child process to supply an ffmpeg audio input that
/// `-f avfoundation`/`gdigrab`/`x11grab` cannot itself produce. Only the
/// macOS branch (system audio, no microphone) ever returns `Some`.
type AudioHelper = Option<(Child, std::path::PathBuf)>;

pub fn spawn(options: &CaptureOptions, output: &Path) -> Result<CaptureProcess, String> {
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
    let audio_helper = platform_input(&mut command, x, y, width, height, options)?;
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
    let video = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            // ffmpeg failed to launch after we already started the audio helper
            // (if any) — don't leak it or its pipe.
            if let Some((mut helper, fifo)) = audio_helper {
                let _ = helper.kill();
                let _ = helper.wait();
                let _ = std::fs::remove_file(fifo);
            }
            return Err(format!(
                "Could not launch FFmpeg: {e}. Install the bundled Cap media runtime."
            ));
        }
    };
    let (system_audio_helper, system_audio_fifo) = match audio_helper {
        Some((child, fifo)) => (Some(child), Some(fifo)),
        None => (None, None),
    };
    Ok(CaptureProcess {
        video,
        system_audio_helper,
        system_audio_fifo,
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
) -> Result<AudioHelper, String> {
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
    Ok(None)
}

#[cfg(target_os = "macos")]
fn platform_input(
    c: &mut Command,
    _x: i32,
    _y: i32,
    _w: u32,
    _h: u32,
    o: &CaptureOptions,
) -> Result<AudioHelper, String> {
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
        return Ok(None);
    }
    if o.system_audio {
        // *** UNVERIFIED — see macos/sck-audio-capture.swift's header comment. ***
        // avfoundation cannot capture macOS system/desktop audio, so when the
        // user wants system audio and picked no microphone, we spawn a
        // separate Swift/ScreenCaptureKit helper process (built by build.rs,
        // macOS only) that writes raw PCM into a named pipe, and feed that
        // pipe to ffmpeg as input index 1 — exactly the input slot the
        // microphone branch above would otherwise occupy, so the shared
        // `-map 1:a:0` / AAC-encode logic in `spawn()` needs no changes.
        //
        // PCM contract with the helper (must match exactly):
        //   32-bit float, little-endian, 48000 Hz, 2-channel interleaved.
        let (helper, fifo) = macos_spawn_system_audio_helper()?;
        c.args([
            "-f",
            "f32le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            &fifo.to_string_lossy(),
        ]);
        return Ok(Some((helper, fifo)));
    }
    Ok(None)
}

/// Creates the named pipe the ScreenCaptureKit helper writes to and ffmpeg
/// reads from, then spawns the helper against it.
///
/// *** UNVERIFIED on real macOS hardware. ***
#[cfg(target_os = "macos")]
fn macos_spawn_system_audio_helper() -> Result<(Child, std::path::PathBuf), String> {
    let helper_binary = macos_system_audio_helper_binary()?;
    let fifo = std::env::temp_dir().join(format!("cap-system-audio-{}.pcm", uuid::Uuid::new_v4()));
    macos_create_fifo(&fifo)?;
    match Command::new(&helper_binary)
        .arg(&fifo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => Ok((child, fifo)),
        Err(e) => {
            let _ = std::fs::remove_file(&fifo);
            Err(format!(
                "Could not launch the macOS system-audio capture helper: {e}"
            ))
        }
    }
}

/// Locates the compiled `sck-audio-capture` helper binary.
///
/// *** UNVERIFIED on real macOS hardware. *** In particular, the assumption
/// that a `bundle.macOS.resources` entry lands at
/// `<App>.app/Contents/Resources/<declared-relative-path>` (preserving the
/// `macos/` prefix it was declared with in tauri.conf.json) has not been
/// confirmed against an actual signed, bundled build — only against Tauri's
/// documentation. This tries a couple of plausible layouts plus a
/// development-time fallback so a wrong guess here fails soft (falls through
/// to the next candidate, then a clear error) rather than silently pointing
/// at nothing.
#[cfg(target_os = "macos")]
fn macos_system_audio_helper_binary() -> Result<std::path::PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // A bundled app's executable lives at <App>.app/Contents/MacOS/<exe>.
        if let Some(contents_dir) = exe.parent().and_then(|macos_dir| macos_dir.parent()) {
            candidates.push(contents_dir.join("Resources/macos/sck-audio-capture"));
            candidates.push(contents_dir.join("Resources/sck-audio-capture"));
        }
    }
    // `cargo tauri dev` / a plain `cargo run` has no app bundle around it;
    // fall back to where build.rs places the compiled binary in the source
    // tree so local development still works.
    candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("macos/sck-audio-capture"));

    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        "The macOS system-audio capture helper is missing from this build. \
         Select a microphone, or disable system audio, or rebuild with Xcode/swiftc installed."
            .into()
    })
}

/// SAFETY: `path` is converted to a NUL-terminated `CString` immediately
/// above the call and is not mutated or retained afterward; `libc::mkfifo`
/// only reads it and returns a plain integer status.
#[cfg(target_os = "macos")]
fn macos_create_fifo(path: &Path) -> Result<(), String> {
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| "Invalid temporary path for the system-audio pipe".to_string())?;
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if result != 0 {
        return Err(format!(
            "Could not create the system-audio pipe at {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
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
) -> Result<AudioHelper, String> {
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
    Ok(None)
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
