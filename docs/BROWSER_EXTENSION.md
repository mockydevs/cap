# Browser extension

The Cap WebExtension provides one-click access to the authenticated recorder and recording library, a keyboard command, and page context-menu actions. It deliberately opens the main Cap web application for capture so browser permission prompts, workspace authorization, IndexedDB recovery, multipart checksums, and AWS signing remain in the audited application instead of being duplicated in privileged extension code.

Chrome and Edge use `manifest.chromium.json`; Firefox uses `manifest.firefox.json`. Run `bash apps/browser-extension/scripts/package.sh chromium` or `firefox` to produce installable ZIPs under `apps/browser-extension/dist`. A tag such as `extension-v0.1.0` validates both manifests, packages both variants, and attaches them to a public GitHub Release.

For local installation, extract the ZIP. Load the directory with Chrome/Edge “Load unpacked,” or use Firefox `about:debugging` → “Load Temporary Add-on” and select `manifest.json`. Store publication requires separate Chrome Web Store, Edge Add-ons, and Firefox Add-ons developer accounts and review.

Safari does not install WebExtension ZIPs directly. Apple requires `xcrun safari-web-extension-converter`, an Xcode container application, Apple signing, notarization, and App Store distribution. The shared source is suitable for conversion, but the Safari package must be produced on macOS with the organization's Apple credentials.
