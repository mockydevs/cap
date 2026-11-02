//! Meeting mode: record a meeting's audio (or screen + audio), stop on its
//! own when the meeting ends or goes quiet for a long time, and send it to
//! the paired Calari client through the Cap server. The engine lives in the
//! shared `cap-meeting-recorder` crate; this module is the Tauri wrapper.

use cap_meeting_detector::{Config as DetectorConfig, Signal};
use cap_meeting_protocol::{
    CaptureMode, DeviceKind, PairingKind, RedeemPairingRequest, RedeemPairingResponse,
};
use cap_meeting_recorder::{
    devices::{self, AudioDevice, InputChoice, Platform},
    Client, Event, Journal, Session, StartOptions,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYRING_SERVICE: &str = "cap-desktop";
/// Older builds stored the server here; it is only ever deleted now.
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
pub async fn meeting_pair(app: AppHandle, code: String) -> Result<PairInfo, String> {
    let server = crate::meeting_server()?;
    let res = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{server}/v1/pairings/redeem"))
        .json(&RedeemPairingRequest {
            code,
            device_name: "Cap desktop".into(),
            device_kind: DeviceKind::Desktop,
            code_verifier: None,
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

/// Each meeting keeps its own credential, so a meeting recorded for one
/// client still uploads after the app is paired with another.
fn meeting_token_key(meeting_id: &str) -> String {
    format!("meeting-token:{meeting_id}")
}

fn token_for_meeting(j: &Journal) -> Option<String> {
    entry(&meeting_token_key(&j.meeting_id))
        .ok()?
        .get_password()
        .ok()
}

fn forget_meeting_token(meeting_id: &str) {
    if let Ok(e) = entry(&meeting_token_key(meeting_id)) {
        let _ = e.delete_credential();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub microphones: Vec<AudioDevice>,
    pub system_audio_available: bool,
    pub platform: &'static str,
}

/// Microphones FFmpeg can see, and whether other people's audio (the
/// computer's sound) can be recorded on this machine.
#[tauri::command]
pub async fn meeting_audio_devices() -> Result<AudioDevices, String> {
    let platform = Platform::current();
    let found = tauri::async_runtime::spawn_blocking(move || {
        devices::list_audio_devices(&crate::ffmpeg_path(), platform)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(AudioDevices {
        system_audio_available: devices::system_audio_available(platform, &found),
        microphones: found.into_iter().filter(|d| !d.loopback).collect(),
        platform: match platform {
            Platform::Linux => "linux",
            Platform::Windows => "windows",
            Platform::Mac => "macos",
        },
    })
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
    let info = load_info(&app).ok_or("Pair Cap with a Calari client first.")?;
    let server = crate::meeting_server()?;
    if info.server_url != server {
        return Err("Pair Cap with a Calari client again.".into());
    }
    let token = device_token().ok_or("Pair Cap with a Calari client first.")?;
    let platform = Platform::current();
    let screen = match (&options.mode, options.video_source_id.as_deref()) {
        (CaptureMode::Video, Some(id)) => Some(crate::capture::source_geometry(id)?),
        _ => None,
    };
    let choice = InputChoice {
        mode: options.mode,
        microphone_id: options.microphone_id.clone(),
        system_audio: options.system_audio,
        screen,
        x11_display: std::env::var("DISPLAY").ok(),
    };
    let list = tauri::async_runtime::spawn_blocking(move || {
        let found = devices::list_audio_devices(&crate::ffmpeg_path(), platform);
        devices::resolve_inputs(platform, &choice, &found)
    })
    .await
    .map_err(|e| e.to_string())??;
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
    let session_token = token.clone();
    // The recorder's HTTP client is blocking: it must be created and dropped
    // off the async runtime, or the app panics and the recording never starts.
    let session = tauri::async_runtime::spawn_blocking(move || {
        let client = Client::new(&server, &session_token).map_err(|e| e.to_string())?;
        let session = Session::start(StartOptions {
            client,
            dir,
            ffmpeg: crate::ffmpeg_path(),
            inputs: list,
            title: options.title,
            mode: options.mode,
            segment_seconds: cap_meeting_recorder::ffmpeg::SEGMENT_SECONDS,
            detector: DetectorConfig::default(),
            watch_window: watch,
            on_event: Arc::new(move |ev: Event| {
                if let Event::Finalized { meeting_id } = &ev {
                    forget_meeting_token(meeting_id);
                }
                let _ = emitter.emit("meeting-event", ev);
            }),
            upload_interval: std::time::Duration::from_secs(3),
            // Starting... until capture produces audio; then Recording.
            ready_timeout: std::time::Duration::from_secs(15),
        })
        .map_err(|e| e.to_string())?;
        keep_credential(session, |id| {
            entry(&meeting_token_key(id))?
                .set_password(&session_token)
                .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let id = session.meeting_id.clone();
    let previous = state.0.lock().map_err(|e| e.to_string())?.replace(session);
    // A finished session still holds a blocking client: drop it off the runtime.
    if let Some(old) = previous {
        tauri::async_runtime::spawn_blocking(move || drop(old));
    }
    Ok(id)
}

pub fn is_recording(state: &MeetingState) -> bool {
    state
        .0
        .lock()
        .map(|s| s.as_ref().is_some_and(Session::is_running))
        .unwrap_or(true)
}

/// A started recording, as far as saving its credential is concerned.
trait Recording {
    fn id(&self) -> String;
    fn stop(&mut self);
}

impl Recording for Session {
    fn id(&self) -> String {
        self.meeting_id.clone()
    }
    fn stop(&mut self) {
        Session::stop(self);
    }
}

/// Each meeting's own credential is saved before Cap reports that recording
/// started, so the meeting can still upload after a crash even if the app
/// was re-paired with another client meanwhile. If the keyring refuses, the
/// capture that just started is stopped and the user is told: never a
/// recording that could not be recovered.
fn keep_credential<R: Recording>(
    mut recording: R,
    save: impl FnOnce(&str) -> Result<(), String>,
) -> Result<R, String> {
    match save(&recording.id()) {
        Ok(()) => Ok(recording),
        Err(e) => {
            recording.stop();
            Err(format!(
                "Cap stopped because it could not save this meeting's credential in the system keyring ({e}). Unlock the keyring and start again."
            ))
        }
    }
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
            if let Some(mut s) = session {
                // Returns once FFmpeg has closed the last segment; uploading
                // carries on in the background and reports by event.
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
        let done = cap_meeting_recorder::recover_all(&root, |j| {
            // The meeting's own credential first, then the current pairing,
            // which the server lets take over only for the same client.
            let mut tokens: Vec<String> = token_for_meeting(j).into_iter().collect();
            if let Some(current) = device_token().filter(|t| !tokens.contains(t)) {
                tokens.push(current);
            }
            tokens
        });
        for cap_meeting_recorder::Recovered { meeting_id: id, .. } in done {
            forget_meeting_token(&id);
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

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRecording {
        stopped: std::rc::Rc<std::cell::Cell<bool>>,
    }

    impl Recording for FakeRecording {
        fn id(&self) -> String {
            "meeting-1".into()
        }
        fn stop(&mut self) {
            self.stopped.set(true);
        }
    }

    #[test]
    fn a_recording_starts_only_once_its_credential_is_saved() {
        let stopped = std::rc::Rc::new(std::cell::Cell::new(false));
        let saved = std::cell::RefCell::new(None);
        let ok = keep_credential(
            FakeRecording {
                stopped: stopped.clone(),
            },
            |id| {
                *saved.borrow_mut() = Some(id.to_owned());
                Ok(())
            },
        );
        assert!(ok.is_ok());
        assert_eq!(saved.borrow().as_deref(), Some("meeting-1"));
        assert!(!stopped.get());

        // Keyring refuses: the capture is stopped and the start fails.
        let failed = keep_credential(
            FakeRecording {
                stopped: stopped.clone(),
            },
            |_| Err("keyring is locked".into()),
        );
        let message = failed.err().expect("start must fail");
        assert!(stopped.get(), "the started capture must be stopped");
        assert!(message.contains("keyring is locked"), "{message}");
    }

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
