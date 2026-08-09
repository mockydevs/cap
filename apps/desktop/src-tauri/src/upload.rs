use crate::{
    model::{Project, ProjectStatus, UploadedPart},
    projects,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    session_id: String,
    recording_id: String,
    part_size_bytes: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedPart {
    url: String,
    required_headers: std::collections::HashMap<String, String>,
}

fn credentials() -> Result<(String, String), String> {
    let server = keyring::Entry::new("cap-desktop", "server-url")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Sign in before uploading")?;
    let token = keyring::Entry::new("cap-desktop", "session-token")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Sign in before uploading")?;
    Ok((server, token))
}

pub async fn upload(
    app: &AppHandle,
    directory: &Path,
    project: &mut Project,
) -> Result<(), String> {
    let (server, token) = credentials()?;
    let client = Client::builder()
        .https_only(server.starts_with("https://"))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = tokio::fs::read(&project.media_path)
        .await
        .map_err(|e| e.to_string())?;
    project.status = ProjectStatus::Uploading;
    projects::save(directory, project)?;
    let session = if let Some(session_id) = &project.upload_session_id {
        Session {
            session_id: session_id.clone(),
            recording_id: project.recording_id.clone().ok_or("Missing recording ID")?,
            part_size_bytes: 8 * 1024 * 1024,
        }
    } else {
        let response = client.post(format!("{server}/api/upload-sessions")).bearer_auth(&token).json(&serde_json::json!({"title":project.title,"contentType":"video/mp4","sizeBytes":bytes.len()})).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Upload session rejected: {}", response.status()));
        }
        let value: Session = response.json().await.map_err(|e| e.to_string())?;
        project.upload_session_id = Some(value.session_id.clone());
        project.recording_id = Some(value.recording_id.clone());
        projects::save(directory, project)?;
        value
    };
    let total = bytes.len().div_ceil(session.part_size_bytes as usize);
    for index in 0..total {
        let number = (index + 1) as u32;
        if project
            .uploaded_parts
            .iter()
            .any(|part| part.part_number == number)
        {
            continue;
        }
        let start = index * session.part_size_bytes as usize;
        let end = (start + session.part_size_bytes as usize).min(bytes.len());
        let body = &bytes[start..end];
        let checksum = STANDARD.encode(Sha256::digest(body));
        let signed_response = client.post(format!("{server}/api/upload-sessions/{}/parts/{number}", session.session_id)).bearer_auth(&token).json(&serde_json::json!({"contentLength":body.len(),"checksumSha256":checksum,"isFinalPart":index+1==total})).send().await.map_err(|e| e.to_string())?;
        if !signed_response.status().is_success() {
            return Err(format!(
                "Part signing rejected: {}",
                signed_response.status()
            ));
        }
        let signed: SignedPart = signed_response.json().await.map_err(|e| e.to_string())?;
        let mut request = client.put(signed.url).body(body.to_vec());
        for (name, value) in signed.required_headers {
            request = request.header(name, value);
        }
        let result = request.send().await.map_err(|e| e.to_string())?;
        if !result.status().is_success() {
            return Err(format!("Part upload failed: {}", result.status()));
        }
        let etag = result
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .ok_or("Storage response omitted ETag")?
            .to_string();
        project.uploaded_parts.push(UploadedPart {
            part_number: number,
            etag,
            checksum_sha256: checksum,
        });
        projects::save(directory, project)?;
        app.emit("upload-progress", ((index + 1) * 100 / total) as u32)
            .map_err(|e| e.to_string())?;
    }
    let parts: Vec<_> = project.uploaded_parts.iter().map(|p|serde_json::json!({"partNumber":p.part_number,"etag":p.etag,"checksumSha256":p.checksum_sha256})).collect();
    let completed = client
        .post(format!(
            "{server}/api/upload-sessions/{}/complete",
            session.session_id
        ))
        .bearer_auth(token)
        .header("idempotency-key", &project.completion_key)
        .json(&serde_json::json!({"parts":parts}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !completed.status().is_success() {
        return Err(format!("Completion rejected: {}", completed.status()));
    }
    project.status = ProjectStatus::Uploaded;
    project.updated_at = chrono::Utc::now();
    projects::save(directory, project)
}
