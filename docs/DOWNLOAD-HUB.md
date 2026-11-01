# Cap download publication contract

The public Rust service serves the download hub at `/` and a universal Calari portal redirect at `/portal` (set `CALARI_PORTAL_URL` to the existing portal URL; required in production). Private meetings keep their separate `/login` Calari SSO and role checks. It never creates Cap password accounts. The hub HTML/CSS is embedded in the Rust binary; there is no general-purpose public directory server.

## Publisher-owned artifact directory

Set `CAP_DOWNLOAD_DIR` to a dedicated directory mounted **read-only** in the Rust container (for example `/srv/downloads`). The publisher, never the public service or a user upload, owns this directory. Missing configuration displays unavailable downloads. When configured, the manifest and available files must validate at startup or the server refuses to start. Restart after publication; do not edit files in place while serving.

Publish installers using immutable versioned basenames. Verify the actual installer, OS, architecture, version, signature/signing status and SHA-256 before setting `available`. Do not publish secrets, internal logs, source bundles or unreviewed extension artifacts here. No GitHub credentials are required by visitors.

`manifest.json` is UTF-8 JSON (maximum 64 KiB), schema:

```json
{
  "schema_version": 1,
  "artifacts": [
    {
      "platform": "linux-x86_64",
      "version": "0.2.0-beta.7",
      "status": "available",
      "filename": "Cap_0.2.0-beta.7_amd64.deb",
      "bytes": 123456,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    {
      "platform": "macos-aarch64",
      "status": "signing_pending"
    }
  ]
}
```

The example hash/size are illustrative, never a published artifact. Supported platform IDs: `linux-x86_64`, `windows-x86_64`, `macos-aarch64`, `macos-x86_64`. Status: `available`, `pending`, `signing_pending` (macOS only). One entry per platform. Missing platforms display unavailable. The Chrome extension is deliberately not accepted in this manifest until its separate review and manual QA are approved.

For `available`, all version/filename/bytes/SHA fields are required; the regular, non-symlink file must exist directly inside this directory, with matching nonzero size (at most 2 GiB) and SHA-256. Names contain only ASCII letters/digits/`._-`, start with an alphanumeric, have no `..`, and end with the platform's exact lowercase `.deb`, `.exe` or `.dmg`. No paths or URLs. Unknown JSON fields and duplicate platforms are rejected. Pending entries contain only platform/status, with no invented version, filename/size/hash and never expose a link. No custom HTML/status text is accepted.

Publish a complete immutable directory/manifest atomically and restart the service. Preserve old files while active downloads finish. Do not replace or alter a live installer's bytes; use a new versioned basename and a new validated manifest. The root release owner must verify real release artifacts before publishing. Unsigned/unreviewed macOS builds remain explicitly disabled; this contract does not waive signing gates.

`GET /api/downloads` exposes only this public installer metadata and same-origin `/downloads/<basename>` links for verified available files. The download handler is an allowlist, never a directory listing. It does not expose `manifest.json` or other directory contents. Range/HEAD handling supports resumable installer downloads; downloads use attachment disposition and `X-Artifact-Sha256` and a hash ETag. Normal sign-in is not required for these explicitly public installers.

## Automatic updater status

The separate signed updater publication contract is pending desktop payload-format verification. This installer-hub release deliberately returns404 for `/downloads/latest.json`; `/api/downloads` labels updates `not_published` and Debian updates `manual`. It does not claim an app is up-to-date or fall back to private GitHub URLs. Direct installers are independent of automatic updater readiness. A future verified updater catalog will be separate from `manifest.json`; do not add unknown fields, payload archives or signature entries to the installer manifest.
