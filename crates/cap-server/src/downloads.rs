//! Public installer allowlist. Only the release publisher can populate the
//! read-only directory; no upload, URL proxy or filesystem browse is exposed.

use anyhow::{bail, Context};
use axum::{
    body::Body,
    extract::{Extension, Path},
    http::{header, HeaderValue, Request, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::SystemTime};
use tokio::io::AsyncReadExt;
use tower_http::services::ServeFile;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Hash)]
pub enum Platform {
    #[serde(rename = "linux-x86_64")]
    Linux,
    #[serde(rename = "windows-x86_64")]
    Windows,
    #[serde(rename = "macos-aarch64")]
    MacArm,
    #[serde(rename = "macos-x86_64")]
    MacIntel,
}

impl Platform {
    fn extension(self) -> &'static str {
        match self {
            Self::Linux => ".deb",
            Self::Windows => ".exe",
            Self::MacArm | Self::MacIntel => ".dmg",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Available,
    Pending,
    SigningPending,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    artifacts: Vec<Artifact>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Artifact {
    Available {
        platform: Platform,
        version: String,
        filename: String,
        bytes: u64,
        sha256: String,
    },
    Pending {
        platform: Platform,
    },
    SigningPending {
        platform: Platform,
    },
}

impl Artifact {
    fn platform(&self) -> Platform {
        match self {
            Self::Available { platform, .. }
            | Self::Pending { platform }
            | Self::SigningPending { platform } => *platform,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct PublicArtifact {
    platform: Platform,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
}

impl PublicArtifact {
    fn pending(platform: Platform, status: Status) -> Self {
        Self {
            platform,
            status,
            version: None,
            filename: None,
            bytes: None,
            sha256: None,
            download_url: None,
        }
    }
}

struct PublishedFile {
    path: PathBuf,
    identity: Identity,
    sha256: String,
}

#[derive(PartialEq)]
struct Identity {
    bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl Identity {
    fn from(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}

pub struct Catalog {
    public: Vec<PublicArtifact>,
    files: HashMap<String, PublishedFile>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            public: [
                Platform::Linux,
                Platform::Windows,
                Platform::MacArm,
                Platform::MacIntel,
            ]
            .into_iter()
            .map(|platform| {
                PublicArtifact::pending(
                    platform,
                    if matches!(platform, Platform::MacArm | Platform::MacIntel) {
                        Status::SigningPending
                    } else {
                        Status::Pending
                    },
                )
            })
            .collect(),
            files: HashMap::new(),
        }
    }
}

fn safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

async fn regular_metadata(path: &std::path::Path) -> anyhow::Result<std::fs::Metadata> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "published file must be a regular non-symlink file"
    );
    Ok(metadata)
}

async fn read_bounded(path: &std::path::Path, limit: u64) -> anyhow::Result<Vec<u8>> {
    let metadata = regular_metadata(path).await?;
    anyhow::ensure!(
        metadata.len() <= limit,
        "published metadata exceeds size limit"
    );
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).await?;
    anyhow::ensure!(
        bytes.len() as u64 <= limit,
        "published metadata exceeds size limit"
    );
    Ok(bytes)
}

impl Catalog {
    /// Fail closed before serving any catalog. Files must remain immutable in
    /// the publisher-owned read-only mount for the lifetime of this process.
    pub async fn load(dir: Option<&std::path::Path>) -> anyhow::Result<Self> {
        let Some(dir) = dir else {
            return Ok(Self::default());
        };
        let metadata = tokio::fs::symlink_metadata(dir)
            .await
            .context("CAP_DOWNLOAD_DIR")?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "CAP_DOWNLOAD_DIR must be a non-symlink directory"
        );
        let dir = tokio::fs::canonicalize(dir).await?;
        let path = dir.join("manifest.json");
        let manifest: Manifest = serde_json::from_slice(
            &read_bounded(&path, MAX_MANIFEST_BYTES)
                .await
                .context("download manifest")?,
        )?;
        anyhow::ensure!(
            manifest.schema_version == 1 && manifest.artifacts.len() <= 4,
            "unsupported download manifest"
        );
        let mut result = Self::default();
        let mut seen = std::collections::HashSet::new();
        for artifact in manifest.artifacts {
            let platform = artifact.platform();
            anyhow::ensure!(seen.insert(platform), "duplicate download platform");
            let public = match artifact {
                Artifact::Available {
                    version,
                    filename: name,
                    bytes,
                    sha256,
                    ..
                } => {
                    anyhow::ensure!(
                        !version.is_empty()
                            && version.len() <= 64
                            && version
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"._-+".contains(&c)),
                        "invalid artifact version"
                    );
                    anyhow::ensure!(
                        safe_filename(&name) && name.ends_with(platform.extension()),
                        "invalid installer basename/extension"
                    );
                    anyhow::ensure!(
                        bytes > 0 && bytes <= MAX_INSTALLER_BYTES,
                        "invalid installer size"
                    );
                    anyhow::ensure!(
                        sha256.len() == 64
                            && sha256
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
                        "invalid artifact SHA-256"
                    );
                    let path = dir.join(&name);
                    let metadata = regular_metadata(&path).await?;
                    anyhow::ensure!(
                        metadata.len() == bytes,
                        "installer size does not match manifest"
                    );
                    let mut file = tokio::fs::File::open(&path).await?;
                    let mut hash = Sha256::new();
                    let mut buffer = [0_u8; 64 * 1024];
                    let mut total = 0_u64;
                    loop {
                        let read = file.read(&mut buffer).await?;
                        if read == 0 {
                            break;
                        }
                        total += read as u64;
                        anyhow::ensure!(total <= bytes, "installer changed during validation");
                        hash.update(&buffer[..read]);
                    }
                    anyhow::ensure!(
                        total == bytes && hex::encode(hash.finalize()) == sha256,
                        "installer SHA-256 does not match manifest"
                    );
                    anyhow::ensure!(
                        Identity::from(&metadata)
                            == Identity::from(&regular_metadata(&path).await?),
                        "installer changed during validation"
                    );
                    let public = PublicArtifact {
                        platform,
                        status: Status::Available,
                        version: Some(version),
                        download_url: Some(format!("/downloads/{name}")),
                        filename: Some(name.clone()),
                        bytes: Some(bytes),
                        sha256: Some(sha256.clone()),
                    };
                    anyhow::ensure!(
                        result
                            .files
                            .insert(
                                name,
                                PublishedFile {
                                    path,
                                    identity: Identity::from(&metadata),
                                    sha256
                                }
                            )
                            .is_none(),
                        "duplicate installer filename"
                    );
                    public
                }
                Artifact::Pending { .. } => PublicArtifact::pending(platform, Status::Pending),
                Artifact::SigningPending { .. } => {
                    if !matches!(platform, Platform::MacArm | Platform::MacIntel) {
                        bail!("signing_pending is reserved for macOS");
                    }
                    PublicArtifact::pending(platform, Status::SigningPending)
                }
            };
            let slot = result
                .public
                .iter_mut()
                .find(|v| v.platform == platform)
                .context("download platform")?;
            *slot = public;
        }
        Ok(result)
    }
}

async fn catalog(Extension(catalog): Extension<Arc<Catalog>>) -> Response {
    let mut response = Json(serde_json::json!({
        "schema_version": 1, "artifacts": catalog.public,
        "extension": { "status": "review_pending" },
        "updates": { "status": "not_published", "debian_updates": "manual" },
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn download(
    Extension(catalog): Extension<Arc<Catalog>>,
    Path(name): Path<String>,
    request: Request<Body>,
) -> Response {
    let Some(file) = catalog.files.get(&name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(metadata) = regular_metadata(&file.path).await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if Identity::from(&metadata) != file.identity {
        tracing::warn!(
            artifact = name,
            "published installer changed; refusing download"
        );
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Ok(response) = ServeFile::new(&file.path).try_call(request).await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let mut response = response.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    // Manifest strings have a strict ASCII allowlist before becoming headers.
    if let (Ok(disposition), Ok(etag), Ok(digest)) = (
        HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")),
        HeaderValue::from_str(&format!("\"sha256-{}\"", file.sha256)),
        HeaderValue::from_str(&file.sha256),
    ) {
        headers.insert(header::CONTENT_DISPOSITION, disposition);
        headers.insert(header::ETAG, etag);
        headers.insert("x-artifact-sha256", digest);
    } else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    response
}

async fn portal(Extension(url): Extension<PortalUrl>) -> Response {
    match url.0 {
        Some(url) => axum::response::Redirect::temporary(&url).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Calari portal sign-in is not configured.",
        )
            .into_response(),
    }
}

#[derive(Clone)]
struct PortalUrl(Option<String>);

async fn public_auth_closed() -> Response {
    (
        StatusCode::GONE,
        Json(
            serde_json::json!({"error":{"code":"CALARI_SIGN_IN_REQUIRED"},"sign_in_url":"/portal"}),
        ),
    )
        .into_response()
}

fn format_file_size(bytes: u64) -> String {
    if bytes < 1_000 {
        format!("{bytes} B")
    } else if bytes < 1_000_000 {
        format!("{:.1} KB", bytes as f64 / 1_000.0)
    } else if bytes < 1_000_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else {
        format!("{:.1} GB", bytes as f64 / 1_000_000_000.0)
    }
}

async fn homepage(Extension(catalog): Extension<Arc<Catalog>>) -> Html<String> {
    let cards = maud::html! {
        @for artifact in &catalog.public {
            article class="download-card" {
                span class="os-icon" aria-hidden="true" { (match artifact.platform { Platform::Linux => "LIN", Platform::Windows => "WIN", _ => "MAC" }) }
                h3 { (match artifact.platform { Platform::Linux => "Linux", Platform::Windows => "Windows", _ => "macOS" }) }
                p class="platform-description" { (match artifact.platform { Platform::Linux => ".deb · x86_64", Platform::Windows => ".exe · x86_64", Platform::MacArm => ".dmg · Apple silicon", Platform::MacIntel => ".dmg · Intel" }) }
                @match artifact.status {
                    Status::Available => { span class="status status-available" { "Verified release" } }
                    Status::SigningPending => { span class="status status-signing" { "Signing pending" } }
                    Status::Pending => { span class="status status-pending" { "Not published yet" } }
                }
                @if let (Some(version), Some(bytes)) = (&artifact.version, artifact.bytes) {
                    p class="release-meta" { "Version " (version) br; (format_file_size(bytes)) }
                } @else {
                    p class="release-meta" { (if artifact.status == Status::SigningPending { "Available after signing and release checks." } else { "The next installer will appear here." }) }
                }
                @if let Some(url) = &artifact.download_url {
                    a class="button button-primary" href=(url) { "Download " (artifact.platform.extension()) span aria-hidden="true" { "↓" } }
                } @else {
                    button class="button button-secondary" type="button" disabled { "Not available yet" }
                }
                @if let Some(sha256) = &artifact.sha256 {
                    details { summary { "Verify SHA-256" } code { (sha256) } }
                }
            }
        }
    };
    Html(
        include_str!("../../../apps/site/index.html")
            .replace("<!-- DOWNLOAD_CARDS -->", &cards.into_string()),
    )
}

async fn css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../../apps/site/styles.css"),
    )
}

pub fn router<S: Clone + Send + Sync + 'static>(
    catalog: Arc<Catalog>,
    portal_url: Option<String>,
) -> Router<S> {
    let mut app = Router::new()
        .route("/", get(homepage))
        .route("/index.html", get(homepage))
        .route("/styles.css", get(css))
        .route("/portal", get(portal))
        .route("/api/downloads", get(self::catalog))
        .route("/downloads/{filename}", get(download));
    for path in [
        "/signup",
        "/register",
        "/api/auth/signup",
        "/api/auth/login",
        "/api/auth/google",
        "/api/auth/google/callback",
        "/api/desktop/auth/login",
        "/api/desktop/auth/google",
        "/api/desktop/auth/google/config",
    ] {
        app = app.route(path, any(public_auth_closed));
    }
    app.layer(Extension(catalog)).layer(Extension(PortalUrl(portal_url)))
        .layer(tower_http::set_header::SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
}
