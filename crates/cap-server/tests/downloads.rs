//! No database or live release artifacts: verify the publisher boundary and
//! actual HTTP bytes/headers using an explicitly synthetic local fixture.
#![allow(clippy::unwrap_used)]

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use cap_server::downloads::{self, Catalog};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tower::ServiceExt;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("cap-download-tests-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn manifest(&self, artifacts: Value) {
        std::fs::write(
            self.0.join("manifest.json"),
            serde_json::to_vec(&json!({"schema_version":1,"artifacts":artifacts})).unwrap(),
        )
        .unwrap();
    }
    fn available(&self) -> Value {
        let body = b"synthetic installer bytes for HTTP tests only\n";
        std::fs::write(self.0.join("Cap_0.0.0-test_amd64.deb"), body).unwrap();
        json!({"platform":"linux-x86_64","status":"available","version":"0.0.0-test","filename":"Cap_0.0.0-test_amd64.deb","bytes":body.len(),"sha256":hex::encode(Sha256::digest(body))})
    }
    async fn catalog(&self) -> Catalog {
        Catalog::load(Some(&self.0)).await.unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn missing_catalog_has_no_downloads_or_invented_versions() {
    let app = downloads::router::<()>(Arc::new(Catalog::load(None).await.unwrap()), None);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/downloads")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(body["artifacts"].as_array().unwrap().len(), 4);
    for item in body["artifacts"].as_array().unwrap() {
        assert!(item.get("download_url").is_none() && item.get("version").is_none());
    }
    assert_eq!(body["extension"]["status"], "review_pending");
    assert_eq!(body["updates"]["status"], "not_published");
    assert_eq!(body["updates"]["debian_updates"], "manual");
}

#[tokio::test]
async fn actual_get_head_range_and_digest_match_verified_bytes() {
    let fixture = Fixture::new();
    let entry = fixture.available();
    fixture.manifest(json!([entry]));
    let app = downloads::router::<()>(Arc::new(fixture.catalog().await), None);
    let uri = "/downloads/Cap_0.0.0-test_amd64.deb";
    let response = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=\"Cap_0.0.0-test_amd64.deb\""
    );
    assert_eq!(
        response.headers()["x-artifact-sha256"],
        entry["sha256"].as_str().unwrap()
    );
    let length = response.headers()["content-length"]
        .to_str()
        .unwrap()
        .parse::<usize>()
        .unwrap();
    let body = to_bytes(response.into_body(), 65536).await.unwrap();
    assert_eq!(body.len(), length);
    assert_eq!(
        hex::encode(Sha256::digest(&body)),
        entry["sha256"].as_str().unwrap()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 65536).await.unwrap().len(),
        0
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("range", "bytes=0-8")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        &to_bytes(response.into_body(), 65536).await.unwrap()[..],
        &body[..9]
    );
}

#[tokio::test]
async fn invalid_or_unlisted_names_never_browse_the_directory() {
    let fixture = Fixture::new();
    let entry = fixture.available();
    fixture.manifest(json!([entry]));
    std::fs::write(fixture.0.join("private.key"), b"not public").unwrap();
    let app = downloads::router::<()>(Arc::new(fixture.catalog().await), None);
    for uri in [
        "/downloads/private.key",
        "/downloads/manifest.json",
        "/downloads/not-published.exe",
        "/downloads/%2e%2e%2fprivate.key",
        "/downloads/latest.json",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(!response.status().is_success(), "{uri}");
    }
}

#[tokio::test]
async fn replaced_or_changed_published_file_fails_closed() {
    let fixture = Fixture::new();
    let entry = fixture.available();
    fixture.manifest(json!([entry]));
    let app = downloads::router::<()>(Arc::new(fixture.catalog().await), None);
    std::fs::write(fixture.0.join("Cap_0.0.0-test_amd64.deb"), b"changed bytes").unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/downloads/Cap_0.0.0-test_amd64.deb")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn malformed_names_hash_sizes_duplicates_and_unknown_fields_are_rejected() {
    let fixture = Fixture::new();
    let valid = fixture.available();
    for name in [
        "../private.deb",
        "Cap..deb",
        "https://example.com/a.deb",
        "Cap\r\n.deb",
        "Cap.exe",
        ".hidden.deb",
        "Cap/installer.deb",
    ] {
        let mut entry = valid.clone();
        entry["filename"] = json!(name);
        fixture.manifest(json!([entry]));
        assert!(Catalog::load(Some(&fixture.0)).await.is_err(), "{name}");
    }
    for (key, value) in [
        ("sha256", json!("0".repeat(64))),
        ("bytes", json!(1)),
        ("arbitrary_url", json!("https://example.com")),
        ("version", json!("")),
    ] {
        let mut entry = valid.clone();
        entry[key] = value;
        fixture.manifest(json!([entry]));
        assert!(Catalog::load(Some(&fixture.0)).await.is_err(), "{key}");
    }
    fixture.manifest(json!([valid.clone(), valid]));
    assert!(Catalog::load(Some(&fixture.0)).await.is_err());
}

#[tokio::test]
async fn pending_entries_publish_no_metadata_and_extension_is_not_an_artifact_platform() {
    let fixture = Fixture::new();
    fixture.manifest(json!([{"platform":"macos-aarch64","status":"signing_pending"}]));
    assert!(Catalog::load(Some(&fixture.0)).await.is_ok());
    for item in [
        json!({"platform":"linux-x86_64","status":"signing_pending"}),
        json!({"platform":"linux-x86_64","status":"pending","version":"fake"}),
        json!({"platform":"linux-x86_64","status":"pending","version":null}),
        json!({"platform":"extension","status":"available"}),
    ] {
        fixture.manifest(json!([item]));
        assert!(Catalog::load(Some(&fixture.0)).await.is_err());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn manifest_and_installer_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let entry = fixture.available();
    fixture.manifest(json!([entry]));
    let path = fixture.0.join("Cap_0.0.0-test_amd64.deb");
    std::fs::rename(&path, fixture.0.join("private.key")).unwrap();
    symlink("private.key", path).unwrap();
    assert!(Catalog::load(Some(&fixture.0)).await.is_err());
    let fixture = Fixture::new();
    fixture.manifest(json!([]));
    std::fs::rename(
        fixture.0.join("manifest.json"),
        fixture.0.join("private.json"),
    )
    .unwrap();
    symlink("private.json", fixture.0.join("manifest.json")).unwrap();
    assert!(Catalog::load(Some(&fixture.0)).await.is_err());
}

#[tokio::test]
async fn server_closes_public_credential_routes_and_preserves_universal_portal_target() {
    let app = downloads::router::<()>(
        Arc::new(Catalog::default()),
        Some("https://calari.example/portal".into()),
    );
    for uri in [
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
        for method in ["GET", "POST"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(uri)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::GONE, "{method} {uri}");
            assert!(!response.headers().contains_key("set-cookie"));
        }
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/portal?next=https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        response.headers()["location"],
        "https://calari.example/portal"
    );
}

#[tokio::test]
async fn server_rendered_hub_works_without_javascript_and_has_only_real_download_links() {
    let fixture = Fixture::new();
    let entry = fixture.available();
    fixture.manifest(json!([entry]));
    let app = downloads::router::<()>(Arc::new(fixture.catalog().await), None);
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert!(response.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("script-src 'none'"));
    let body = String::from_utf8(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("href=\"/downloads/Cap_0.0.0-test_amd64.deb\""));
    assert!(body.contains("href=\"/portal\""));
    assert!(
        !body.contains("github.com")
            && !body.contains("<script")
            && !body.contains("<!-- DOWNLOAD_CARDS -->")
    );
    assert_eq!(body.matches("href=\"/downloads/").count(), 1);
    assert!(body.contains("Signing pending"));
    assert!(body.contains("Chrome extension"));
}

#[tokio::test]
async fn oversized_or_unknown_schema_manifest_fails_before_any_download_is_exposed() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("manifest.json"), vec![b' '; 65537]).unwrap();
    assert!(Catalog::load(Some(&fixture.0)).await.is_err());
    std::fs::write(
        fixture.0.join("manifest.json"),
        br#"{"schema_version":2,"artifacts":[]}"#,
    )
    .unwrap();
    assert!(Catalog::load(Some(&fixture.0)).await.is_err());
}

#[tokio::test]
async fn available_windows_installer_discloses_unsigned_status_without_inventing_mac_readiness() {
    let fixture = Fixture::new();
    let mut entry = fixture.available();
    std::fs::rename(
        fixture.0.join("Cap_0.0.0-test_amd64.deb"),
        fixture.0.join("Cap_0.0.0-test_setup.exe"),
    )
    .unwrap();
    entry["platform"] = json!("windows-x86_64");
    entry["filename"] = json!("Cap_0.0.0-test_setup.exe");
    fixture.manifest(json!([entry]));
    let app = downloads::router::<()>(Arc::new(fixture.catalog().await), None);
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = String::from_utf8(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("Windows installer is currently unsigned."));
    assert!(body.contains("Signing pending"));
    let app = downloads::router::<()>(Arc::new(Catalog::default()), None);
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = String::from_utf8(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!body.contains("Windows installer is currently unsigned."));
}

#[tokio::test]
async fn editorial_assets_have_explicit_bounded_routes_without_directory_serving() {
    let app = downloads::router::<()>(Arc::new(Catalog::default()), None);
    for (path, mime, max) in [
        (
            "/assets/cap-recording-editorial-v1-1200.webp",
            "image/webp",
            100_000,
        ),
        (
            "/assets/cap-recording-editorial-v1-640.webp",
            "image/webp",
            50_000,
        ),
        ("/assets/calari-wordmark-navy.svg", "image/svg+xml", 20_000),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], mime);
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["cache-control"], "public, max-age=86400");
        let bytes = to_bytes(response.into_body(), max).await.unwrap();
        assert!(!bytes.is_empty());
        if mime == "image/webp" {
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WEBP");
        }
    }
    for path in [
        "/assets/manifest.json",
        "/assets/private.key",
        "/assets/source.png",
        "/assets/%2e%2e/private.key",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
