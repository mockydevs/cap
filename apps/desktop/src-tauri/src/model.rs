use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
// These variants are part of the serialized capture-source contract even
// before each device enumerator is available on every desktop platform.
#[allow(dead_code)]
pub enum SourceKind {
    Monitor,
    Window,
    Camera,
    Microphone,
    SystemAudio,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub permission_guidance: Vec<String>,
    pub sources: Vec<CaptureSource>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub title: String,
    pub video_source_id: String,
    pub microphone_id: Option<String>,
    pub system_audio: bool,
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
    pub quality: u8,
    pub cursor: bool,
    pub region: Option<Region>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectStatus {
    Recording,
    Recoverable,
    Ready,
    Uploading,
    Uploaded,
    Failed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub status: ProjectStatus,
    pub media_path: PathBuf,
    pub duration_ms: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub upload_session_id: Option<String>,
    pub recording_id: Option<String>,
    pub completion_key: String,
    pub uploaded_parts: Vec<UploadedPart>,
    pub failure: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedPart {
    pub part_number: u32,
    pub etag: String,
    pub checksum_sha256: String,
}
