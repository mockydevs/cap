mod capture;
mod meeting;
mod model;
mod projects;

use chrono::Utc;
use model::{Capabilities, CaptureOptions, Project, ProjectStatus};
use std::{io::Write, process::Child, sync::Mutex, time::Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use url::Url;
use uuid::Uuid;

struct ActiveRecording {
    process: capture::CaptureProcess,
    project: Project,
    directory: std::path::PathBuf,
    started: Instant,
    paused: bool,
}
#[derive(Default)]
struct DesktopState {
    active: Mutex<Option<ActiveRecording>>,
}

#[tauri::command]
fn capture_capabilities() -> Result<Capabilities, String> {
    capture::capabilities()
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    projects::load_all(&projects::root(&app)?)
}

#[tauri::command]
fn start_recording(
    app: AppHandle,
    state: State<DesktopState>,
    options: CaptureOptions,
) -> Result<Project, String> {
    if options.title.trim().is_empty() || options.title.chars().count() > 160 {
        return Err("A recording title between 1 and 160 characters is required".into());
    }
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Recorder state is unavailable")?;
    if active.is_some() {
        return Err("A recording is already active".into());
    }
    let id = Uuid::new_v4().to_string();
    let directory = projects::root(&app)?.join(&id);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let media_path = directory.join("source.mp4");
    let now = Utc::now();
    let project = Project {
        id,
        title: options.title.trim().to_string(),
        status: ProjectStatus::Recording,
        media_path: media_path.clone(),
        duration_ms: 0,
        created_at: now,
        updated_at: now,
        upload_session_id: None,
        recording_id: None,
        completion_key: Uuid::new_v4().to_string(),
        uploaded_parts: Vec::new(),
        failure: None,
    };
    projects::save(&directory, &project)?;
    let process = capture::spawn(&options, &media_path)?;
    *active = Some(ActiveRecording {
        process,
        project: project.clone(),
        directory,
        started: Instant::now(),
        paused: false,
    });
    app.emit("recording-started", &project)
        .map_err(|e| e.to_string())?;
    Ok(project)
}

fn signal_process(child: &Child, pause: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        let signal = if pause { "STOP" } else { "CONT" };
        let result = std::process::Command::new("kill")
            .args([format!("-{signal}"), child.id().to_string()])
            .status()
            .map_err(|e| e.to_string())?;
        if !result.success() {
            return Err("Could not change recorder state".into());
        }
    }
    #[cfg(windows)]
    {
        let action = if pause {
            "Suspend-Process"
        } else {
            "Resume-Process"
        };
        let result = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("{action} -Id {}", child.id()),
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !result.success() {
            return Err("Could not change recorder state".into());
        }
    }
    Ok(())
}

/// Stops the macOS ScreenCaptureKit system-audio helper (if one is running)
/// and removes its named pipe. A no-op everywhere else, since
/// `system_audio_helper`/`system_audio_fifo` are only ever populated by
/// `capture::spawn` on macOS when system audio is requested with no
/// microphone selected.
///
/// Sends SIGTERM rather than using `Child::kill` (which sends SIGKILL on
/// Unix) so the helper's own signal handler gets a chance to stop its
/// SCStream and close the pipe's write end cleanly — see
/// macos/sck-audio-capture.swift. Falls back to a hard kill if it does not
/// exit within a few seconds, so `stop_recording` can never hang waiting on
/// a stuck helper. UNVERIFIED on real macOS hardware.
fn stop_system_audio_helper(process: &mut capture::CaptureProcess) {
    if let Some(mut helper) = process.system_audio_helper.take() {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &helper.id().to_string()])
                .status();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match helper.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                _ => {
                    let _ = helper.kill();
                    let _ = helper.wait();
                    break;
                }
            }
        }
    }
    if let Some(fifo) = process.system_audio_fifo.take() {
        let _ = std::fs::remove_file(fifo);
    }
}

#[tauri::command]
fn pause_recording(state: State<DesktopState>) -> Result<(), String> {
    let mut guard = state
        .active
        .lock()
        .map_err(|_| "Recorder state is unavailable")?;
    let active = guard.as_mut().ok_or("No active recording")?;
    if !active.paused {
        signal_process(&active.process.video, true)?;
        // The macOS system-audio helper (when present) is a process
        // independent of ffmpeg, so pausing ffmpeg alone would leave it
        // capturing into a pipe ffmpeg has stopped draining, which fills the
        // pipe's kernel buffer and eventually blocks the helper's audio
        // callback. Suspending it too keeps pause semantics consistent with
        // the microphone path, where ffmpeg being paused freezes capture
        // entirely. UNVERIFIED: not exercised on real macOS hardware.
        if let Some(helper) = &active.process.system_audio_helper {
            signal_process(helper, true)?;
        }
        active.paused = true;
    }
    Ok(())
}
#[tauri::command]
fn resume_recording(state: State<DesktopState>) -> Result<(), String> {
    let mut guard = state
        .active
        .lock()
        .map_err(|_| "Recorder state is unavailable")?;
    let active = guard.as_mut().ok_or("No active recording")?;
    if active.paused {
        signal_process(&active.process.video, false)?;
        if let Some(helper) = &active.process.system_audio_helper {
            signal_process(helper, false)?;
        }
        active.paused = false;
    }
    Ok(())
}

#[tauri::command]
fn stop_recording(app: AppHandle, state: State<DesktopState>) -> Result<Project, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Recorder state is unavailable")?
        .take()
        .ok_or("No active recording")?;
    if active.paused {
        signal_process(&active.process.video, false)?;
        if let Some(helper) = &active.process.system_audio_helper {
            signal_process(helper, false)?;
        }
    }
    if let Some(stdin) = active.process.video.stdin.as_mut() {
        stdin.write_all(b"q\n").map_err(|e| e.to_string())?;
    }
    let status = active.process.video.wait().map_err(|e| e.to_string())?;
    stop_system_audio_helper(&mut active.process);
    active.project.duration_ms = active.started.elapsed().as_millis() as u64;
    active.project.updated_at = Utc::now();
    active.project.status = if status.success()
        && active
            .project
            .media_path
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    {
        ProjectStatus::Ready
    } else {
        active.project.failure = Some(format!("Recorder exited with {status}"));
        ProjectStatus::Failed
    };
    projects::save(&active.directory, &active.project)?;
    app.emit("recording-stopped", &active.project)
        .map_err(|e| e.to_string())?;
    Ok(active.project)
}

#[tauri::command]
fn delete_project(
    app: AppHandle,
    state: State<DesktopState>,
    project_id: String,
) -> Result<(), String> {
    if state
        .active
        .lock()
        .map_err(|_| "Recorder state is unavailable")?
        .as_ref()
        .is_some_and(|a| a.project.id == project_id)
    {
        return Err("Stop the recording before deleting it".into());
    }
    if Uuid::parse_str(&project_id).is_err() {
        return Err("Invalid project ID".into());
    }
    projects::delete(&projects::root(&app)?.join(project_id))
}

#[tauri::command]
fn reveal_project(app: AppHandle, project_id: String) -> Result<(), String> {
    if Uuid::parse_str(&project_id).is_err() {
        return Err("Invalid project ID".into());
    }
    let path = projects::root(&app)?.join(project_id);
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Release builds get the update address and signing key from the release
/// workflow; other builds have no endpoint, so this does nothing.
fn check_for_update(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = handle.updater() else {
            return;
        };
        if let Ok(Some(update)) = updater.check().await {
            let _ = handle.emit("update-available", update.version.clone());
        }
    });
}

/// Installs a signed update and restarts, only when nothing is recording.
/// Uploads still in progress resume after the restart.
#[tauri::command]
async fn install_update(
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    meetings: State<'_, meeting::MeetingState>,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let busy = desktop.active.lock().map_err(|e| e.to_string())?.is_some()
        || meeting::is_recording(&meetings);
    if busy {
        return Err("Stop the recording before updating Cap.".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Cap is already up to date.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// FFmpeg to record with. Windows installers bundle `ffmpeg.exe` next to the
/// app (a Tauri sidecar); Linux packages depend on the distribution's FFmpeg.
pub(crate) fn ffmpeg_path() -> String {
    #[cfg(target_os = "windows")]
    if let Some(bundled) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("ffmpeg.exe")))
        .filter(|path| path.is_file())
    {
        return bundled.to_string_lossy().into_owned();
    }
    "ffmpeg".into()
}

/// The Cap server this build talks to. Release builds bake in an https
/// address at build time (build.rs refuses to build without one) and never
/// accept a local one. Debug builds may point at a local server with
/// `CAP_DEV_SERVER_URL`. The server never comes from a link or a form.
pub(crate) fn meeting_server() -> Result<String, String> {
    let configured = option_env!("CAP_DEFAULT_SERVER_URL").map(str::to_owned);
    #[cfg(debug_assertions)]
    let configured = std::env::var("CAP_DEV_SERVER_URL").ok().or(configured);
    let value = configured.ok_or("This copy of Cap has no server configured.")?;
    checked_server_url(&value, cfg!(debug_assertions))
}

fn checked_server_url(value: &str, allow_local: bool) -> Result<String, String> {
    let parsed =
        Url::parse(value.trim().trim_end_matches('/')).map_err(|_| "Invalid server URL")?;
    let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok = match parsed.scheme() {
        "https" => !local || allow_local,
        "http" => local && allow_local,
        _ => false,
    };
    if !scheme_ok
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("The Cap server must be an https address.".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch (for example a cap:// link) is
        // forwarded to the running app instead of opening another window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(DesktopState::default())
        .manage(meeting::PendingLink::default())
        .manage(meeting::MeetingState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let text = shortcut.to_string();
                        let name = if text.ends_with("Shift+R") {
                            "shortcut-record"
                        } else {
                            "shortcut-pause"
                        };
                        let _ = app.emit(name, ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.global_shortcut().register("CommandOrControl+Shift+R")?;
            app.global_shortcut().register("CommandOrControl+Shift+P")?;
            let _ =
                projects::load_all(&projects::root(app.handle()).map_err(std::io::Error::other)?);
            meeting::recover_in_background(app.handle());
            check_for_update(app.handle());
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        meeting::handle_link(&handle, url.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        meeting::handle_link(app.handle(), url.as_str());
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_capabilities,
            list_projects,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            delete_project,
            reveal_project,
            meeting::meeting_pair,
            meeting::meeting_device,
            meeting::meeting_unpair,
            meeting::meeting_start,
            meeting::meeting_signal,
            meeting::meeting_recording,
            meeting::meeting_pending_link,
            meeting::meeting_audio_devices,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Cap desktop")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_only_talk_to_https_servers() {
        assert_eq!(
            checked_server_url("https://meetings.calari.tech/", false).unwrap(),
            "https://meetings.calari.tech"
        );
        for bad in [
            "http://meetings.calari.tech",
            "https://localhost:8787",
            "http://127.0.0.1:8787",
            "https://user:pw@meetings.calari.tech",
            "https://meetings.calari.tech/?next=x",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(checked_server_url(bad, false).is_err(), "{bad}");
        }
        // Debug builds may use a local server for development.
        assert!(checked_server_url("http://127.0.0.1:8787", true).is_ok());
        assert!(checked_server_url("http://meetings.calari.tech", true).is_err());
    }
}
