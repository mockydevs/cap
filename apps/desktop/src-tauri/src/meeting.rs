//! Meeting mode: record a meeting's audio (or screen + audio), stop on its
//! own when the meeting ends or goes quiet for a long time, and send it to
//! the paired Calari client through the Cap server. The engine lives in the
//! shared `cap-meeting-recorder` crate; this module is the Tauri wrapper.

use cap_meeting_detector::{Config as DetectorConfig, Signal};
use cap_meeting_protocol::{
    CaptureMode, DeviceKind, PairingKind, RedeemPairingRequest, RedeemPairingResponse,
};
use cap_meeting_recorder::{ffmpeg::Input, Client, Event, Session, StartOptions};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYRING_SERVICE: &str = "cap-desktop";
const KEY_SERVER: &str = "meeting-server-url";
const KEY_TOKEN: &str = "meeting-device-token";

#[derive(Default)]
pub struct MeetingState(Mutex<Option<Session>>);

/// Non-secret pairing details shown in the UI. The token stays in the OS
/// credential store.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub server_url: String,
    pub pairing_kind: PairingKind,
    pub client_name: Option<String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingOptions {
    pub title: String,
    pub mode: CaptureMode,
    pub microphone_id: Option<String>,
    pub system_audio: bool,
    /// Screen to record in video mode (a capture source id).
    pub video_source_id: Option<String>,
    /// Stop when no window title contains this text (e.g. "Zoom Meeting").
    pub watch_window: Option<String>,
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn meetings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("meetings"))
}

fn info_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("meeting-device.json"))
}

fn load_info(app: &AppHandle) -> Option<PairInfo> {
    let text = std::fs::read_to_string(info_path(app).ok()?).ok()?;
    let info: PairInfo = serde_json::from_str(&text).ok()?;
    (info.expires_at > chrono::Utc::now()).then_some(info)
}

fn device_token() -> Option<String> {
    entry(KEY_TOKEN).ok()?.get_password().ok()
}

#[tauri::command]
pub async fn meeting_pair(
    app: AppHandle,
    server_url: String,
    code: String,
) -> Result<PairInfo, String> {
    let server = crate::checked_server_url(&server_url)?;
    let res = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{server}/v1/pairings/redeem"))
        .json(&RedeemPairingRequest {
            code,
            device_name: "Cap desktop".into(),
            device_kind: DeviceKind::Desktop,
        })
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    match res.status().as_u16() {
        200 => {}
        404 => return Err("That code is wrong, already used or expired.".into()),
        429 => return Err("Too many attempts. Wait a few minutes and try again.".into()),
        s => return Err(format!("The Cap server returned {s}.")),
    }
    let body: RedeemPairingResponse = res.json().await.map_err(|e| e.to_string())?;
    entry(KEY_SERVER)?
        .set_password(&server)
        .map_err(|e| e.to_string())?;
    entry(KEY_TOKEN)?
        .set_password(&body.device_token)
        .map_err(|e| e.to_string())?;
    let info = PairInfo {
        server_url: server,
        pairing_kind: body.pairing_kind,
        client_name: body.client_display_name,
        expires_at: body.expires_at,
    };
    let path = info_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_vec(&info).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
pub fn meeting_device(app: AppHandle) -> Option<PairInfo> {
    load_info(&app)
}

#[tauri::command]
pub fn meeting_unpair(app: AppHandle) -> Result<(), String> {
    for key in [KEY_SERVER, KEY_TOKEN] {
        if let Ok(e) = entry(key) {
            let _ = e.delete_credential();
        }
    }
    let _ = std::fs::remove_file(info_path(&app)?);
    Ok(())
}

fn inputs(opts: &MeetingOptions) -> Result<Vec<Input>, String> {
    let mut list = Vec::new();
    if opts.mode == CaptureMode::Video {
        let id = opts
            .video_source_id
            .as_deref()
            .ok_or("Choose a screen to record")?;
        let (x, y, width, height) = crate::capture::source_geometry(id)?;
        #[cfg(target_os = "linux")]
        list.push(Input::LinuxX11 {
            display: std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()),
            x,
            y,
            width,
            height,
        });
        #[cfg(target_os = "windows")]
        list.push(Input::WindowsGdi {
            x,
            y,
            width,
            height,
        });
        #[cfg(target_os = "macos")]
        {
            let _ = (x, y, width, height);
            return Err("Video meeting mode is not available on macOS yet; use audio mode or the screen recorder.".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        list.push(Input::LinuxPulse {
            source: opts
                .microphone_id
                .clone()
                .unwrap_or_else(|| "default".into()),
        });
        if opts.system_audio {
            list.push(Input::LinuxMonitor);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mic = opts.microphone_id.clone().ok_or("Choose a microphone")?;
        list.push(Input::WindowsDshow { device: mic });
        if opts.system_audio {
            list.push(Input::WindowsDshow {
                device: "virtual-audio-capturer".into(),
            });
        }
    }
    #[cfg(target_os = "macos")]
    {
        // System audio on macOS needs the ScreenCaptureKit helper, which has
        // not been verified on real hardware; meeting mode records the mic.
        list.push(Input::MacAvfoundation {
            device: opts.microphone_id.clone().unwrap_or_else(|| "0".into()),
        });
    }
    Ok(list)
}

#[tauri::command]
pub async fn meeting_start(
    app: AppHandle,
    state: State<'_, MeetingState>,
    options: MeetingOptions,
) -> Result<String, String> {
    if state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(Session::is_running)
    {
        return Err("A meeting is already being recorded.".into());
    }
    load_info(&app).ok_or("Pair Cap with a Calari client first.")?;
    let server = entry(KEY_SERVER)?
        .get_password()
        .map_err(|_| "Pair Cap with a Calari client first.")?;
    let token = device_token().ok_or("Pair Cap with a Calari client first.")?;
    let client = Client::new(&server, &token).map_err(|e| e.to_string())?;
    let list = inputs(&options)?;
    let dir = meetings_dir(&app)?.join(uuid::Uuid::new_v4().to_string());
    let watch = options
        .watch_window
        .clone()
        .filter(|w| !w.trim().is_empty())
        .map(|needle| {
            let needle = needle.to_lowercase();
            Box::new(move || {
                xcap::Window::all()
                    .map(|ws| {
                        ws.iter()
                            .any(|w| w.title().is_ok_and(|t| t.to_lowercase().contains(&needle)))
                    })
                    .unwrap_or(true) // if windows cannot be listed, do not stop
            }) as Box<dyn Fn() -> bool + Send>
        });
    let emitter = app.clone();
    let session = tauri::async_runtime::spawn_blocking(move || {
        Session::start(StartOptions {
            client,
            dir,
            ffmpeg: "ffmpeg".into(),
            inputs: list,
            title: options.title,
            mode: options.mode,
            segment_seconds: cap_meeting_recorder::ffmpeg::SEGMENT_SECONDS,
            detector: DetectorConfig::default(),
            watch_window: watch,
            on_event: Box::new(move |ev: Event| {
                let _ = emitter.emit("meeting-event", ev);
            }),
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let id = session.meeting_id.clone();
    *state.0.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(id)
}

/// `keep` answers the inactivity warning; `stop` ends the recording.
#[tauri::command]
pub async fn meeting_signal(state: State<'_, MeetingState>, action: String) -> Result<(), String> {
    match action.as_str() {
        "keep" => {
            if let Some(s) = state.0.lock().map_err(|e| e.to_string())?.as_ref() {
                s.signal(Signal::KeepRecording);
            }
            Ok(())
        }
        "stop" => {
            let session = state.0.lock().map_err(|e| e.to_string())?.take();
            if let Some(s) = session {
                // Waits for FFmpeg to close the last segment and the upload.
                tauri::async_runtime::spawn_blocking(move || s.stop())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        _ => Err("unknown action".into()),
    }
}

#[tauri::command]
pub fn meeting_recording(state: State<'_, MeetingState>) -> Result<Option<String>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|s| s.is_running())
        .map(|s| s.meeting_id.clone()))
}

/// Finishes meetings a crash or power loss left behind.
pub fn recover_in_background(app: &AppHandle) {
    let Ok(root) = meetings_dir(app) else { return };
    let emitter = app.clone();
    std::thread::spawn(move || {
        let done = cap_meeting_recorder::recover_all(&root, |_| device_token());
        for id in done {
            let _ = emitter.emit("meeting-event", Event::Finalized { meeting_id: id });
        }
    });
}

// ---- "Add note taker" links from Calari: cap://pair?code=XXXX-XXXX&mode=audio ----
//
// Any web page can open a cap:// link, so a link never starts recording by
// itself and never chooses the server: it only pre-fills the pairing code and
// mode, and the window asks the user to confirm with one click.

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteTakerLink {
    pub code: String,
    pub mode: CaptureMode,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<NoteTakerLink>>);

pub fn parse_link(raw: &str) -> Option<NoteTakerLink> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "cap" || url.host_str() != Some("pair") {
        return None;
    }
    let mut code = None;
    let mut mode = CaptureMode::Audio;
    let mut title = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = cap_meeting_protocol::ids::normalize_pairing_code(&v),
            "mode" => mode = CaptureMode::parse(&v)?,
            "title" => title = cap_meeting_protocol::clean_text(&v, 200),
            _ => {}
        }
    }
    let code = code?;
    Some(NoteTakerLink {
        code: format!("{}-{}", &code[..4], &code[4..]),
        mode,
        title,
    })
}

pub fn handle_link(app: &AppHandle, raw: &str) {
    let Some(link) = parse_link(raw) else { return };
    if let Some(state) = app.try_state::<PendingLink>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(link.clone());
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("note-taker-request", link);
}

/// A link that arrived before the window was listening.
#[tauri::command]
pub fn meeting_pending_link(state: State<'_, PendingLink>) -> Option<NoteTakerLink> {
    state.0.lock().ok().and_then(|mut s| s.take())
}

/// The server a note-taker link pairs with: one the user already uses, or the
/// build's default. Never one taken from the link.
#[tauri::command]
pub fn meeting_known_server() -> Option<String> {
    entry(KEY_SERVER)
        .ok()
        .and_then(|e| e.get_password().ok())
        .or_else(|| entry("server-url").ok().and_then(|e| e.get_password().ok()))
        .or_else(|| option_env!("CAP_DEFAULT_SERVER_URL").map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_taker_links() {
        assert_eq!(
            parse_link("cap://pair?code=7kq2m9xd&mode=video&title=Acme%20kickoff"),
            Some(NoteTakerLink {
                code: "7KQ2-M9XD".into(),
                mode: CaptureMode::Video,
                title: Some("Acme kickoff".into())
            })
        );
        assert_eq!(
            parse_link("cap://pair?code=7KQ2-M9XD").map(|l| l.mode),
            Some(CaptureMode::Audio)
        );
        // The server can never come from the link.
        assert!(
            parse_link("cap://pair?code=7KQ2-M9XD&server=https://evil.example")
                .is_some_and(|l| l.code == "7KQ2-M9XD")
        );
        for bad in [
            "cap://pair",
            "cap://pair?code=nope",
            "cap://record?code=7KQ2-M9XD",
            "https://pair?code=7KQ2-M9XD",
            "cap://pair?code=7KQ2-M9XD&mode=screen",
        ] {
            assert_eq!(parse_link(bad), None, "{bad}");
        }
    }
}
