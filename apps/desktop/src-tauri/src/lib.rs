mod capture;
mod model;
mod projects;
mod upload;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use model::{Capabilities, CaptureOptions, Project, ProjectStatus};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::{io::Write, process::Child, sync::Mutex, time::Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    user: LoginUser,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginUser {
    display_name: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResult {
    display_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleDesktopConfig {
    client_id: String,
}
#[derive(serde::Deserialize)]
struct GoogleTokenResponse {
    id_token: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCapResponse {
    token: String,
    display_name: String,
}

fn checked_server_url(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value.trim_end_matches('/')).map_err(|_| "Invalid server URL")?;
    if parsed.scheme() != "https" && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1")) {
        return Err("The server must use HTTPS".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
async fn login(server_url: String, email: String, password: String) -> Result<LoginResult, String> {
    let server = checked_server_url(&server_url)?;
    let response = reqwest::Client::new()
        .post(format!("{server}/api/desktop/auth/login"))
        .json(&serde_json::json!({"email":email,"password":password}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Invalid email or password".into());
    }
    let authenticated: LoginResponse = response.json().await.map_err(|e| e.to_string())?;
    keyring::Entry::new("cap-desktop", "server-url")
        .map_err(|e| e.to_string())?
        .set_password(&server)
        .map_err(|e| e.to_string())?;
    keyring::Entry::new("cap-desktop", "session-token")
        .map_err(|e| e.to_string())?
        .set_password(&authenticated.token)
        .map_err(|e| e.to_string())?;
    Ok(LoginResult {
        display_name: authenticated.user.display_name,
    })
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    if status.map_err(|error| error.to_string())?.success() {
        Ok(())
    } else {
        Err("Could not open the system browser".into())
    }
}

#[tauri::command]
async fn google_login(server_url: String) -> Result<LoginResult, String> {
    let server = checked_server_url(&server_url)?;
    let client = reqwest::Client::new();
    let config_response = client
        .get(format!("{server}/api/desktop/auth/google/config"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !config_response.status().is_success() {
        return Err("Google sign-in is not configured on this server".into());
    }
    let config: GoogleDesktopConfig = config_response
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}",
        listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port()
    );
    let mut verifier_bytes = [0u8; 32];
    let mut state_bytes = [0u8; 32];
    let mut nonce_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut verifier_bytes);
    rand::rng().fill_bytes(&mut state_bytes);
    rand::rng().fill_bytes(&mut nonce_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|error| error.to_string())?;
    authorization
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account");
    open_system_browser(authorization.as_str())?;
    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
            .await
            .map_err(|_| "Google sign-in timed out")?
            .map_err(|error| error.to_string())?;
    let mut request = vec![0u8; 8192];
    let length = stream
        .read(&mut request)
        .await
        .map_err(|error| error.to_string())?;
    let request_text = String::from_utf8_lossy(&request[..length]);
    let target = request_text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("Invalid OAuth callback")?;
    let callback =
        Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Invalid OAuth callback")?;
    let parameters: std::collections::HashMap<_, _> = callback.query_pairs().collect();
    if parameters.get("state").map(|value| value.as_ref()) != Some(state.as_str()) {
        return Err("Google sign-in state did not match".into());
    }
    let code = parameters
        .get("code")
        .ok_or("Google did not return an authorization code")?;
    let message = "<!doctype html><title>Cap</title><p>Sign-in complete. You may close this window and return to Cap.</p>";
    stream
        .write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}", message.len()).as_bytes(),
        )
        .await
        .map_err(|error| error.to_string())?;
    let google_response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_ref()),
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !google_response.status().is_success() {
        return Err("Google authorization-code exchange failed".into());
    }
    let google_token: GoogleTokenResponse = google_response
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let cap_response = client
        .post(format!("{server}/api/desktop/auth/google"))
        .json(&serde_json::json!({"idToken":google_token.id_token,"nonce":nonce}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !cap_response.status().is_success() {
        return Err("The Cap server rejected Google sign-in".into());
    }
    let authenticated: GoogleCapResponse = cap_response
        .json()
        .await
        .map_err(|error| error.to_string())?;
    keyring::Entry::new("cap-desktop", "server-url")
        .map_err(|error| error.to_string())?
        .set_password(&server)
        .map_err(|error| error.to_string())?;
    keyring::Entry::new("cap-desktop", "session-token")
        .map_err(|error| error.to_string())?
        .set_password(&authenticated.token)
        .map_err(|error| error.to_string())?;
    Ok(LoginResult {
        display_name: authenticated.display_name,
    })
}

#[tauri::command]
fn logout() -> Result<(), String> {
    for key in ["session-token", "server-url"] {
        let entry = keyring::Entry::new("cap-desktop", key).map_err(|e| e.to_string())?;
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
async fn upload_project(app: AppHandle, project_id: String) -> Result<Project, String> {
    if Uuid::parse_str(&project_id).is_err() {
        return Err("Invalid project ID".into());
    }
    let directory = projects::root(&app)?.join(&project_id);
    let mut project = projects::load_all(&projects::root(&app)?)?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("Project not found")?;
    if !matches!(
        project.status,
        ProjectStatus::Ready
            | ProjectStatus::Recoverable
            | ProjectStatus::Failed
            | ProjectStatus::Uploading
    ) {
        return Err("Project cannot be uploaded in its current state".into());
    }
    match upload::upload(&app, &directory, &mut project).await {
        Ok(()) => Ok(project),
        Err(error) => {
            project.status = ProjectStatus::Failed;
            project.failure = Some(error.clone());
            project.updated_at = Utc::now();
            projects::save(&directory, &project)?;
            Err(error)
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::default())
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
            login,
            google_login,
            logout,
            upload_project
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Cap desktop")
}
