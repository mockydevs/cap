# Linux build environment for the Tauri desktop app (matches the CI apt list).
FROM rust:1.95-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev patchelf libxdo-dev libpipewire-0.3-dev libgbm-dev libclang-dev && rm -rf /var/lib/apt/lists/* \
    && rustup component add rustfmt clippy
