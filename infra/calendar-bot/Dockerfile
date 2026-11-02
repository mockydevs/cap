# Calendar attendance runner. Build from the repository root:
#   docker build -f infra/calendar-bot/Dockerfile -t cap-meeting-bot .
# Runs headed Chromium on a private X display and records the meeting audio
# from a private PulseAudio null sink. No database, no Google/Calari secrets,
# no Docker socket: it holds only its runner token.

FROM rust:1.95-bookworm AS build
WORKDIR /src
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
# Test images only: "fake-meet" lets the runner open a local Meet stand-in.
ARG BOT_FEATURES=""
ARG TARGETPLATFORM
COPY Cargo.toml Cargo.lock clippy.toml ./
COPY crates crates
COPY apps/site apps/site
# Same caching as the server (see crates/cap-server/Dockerfile). The target
# cache is keyed by BOT_FEATURES, so a test build never shares artifacts
# with the release build.
RUN --mount=type=cache,id=cap-cargo-registry-rust1.95,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cap-cargo-git-rust1.95,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cap-bot-target-rust1.95-${TARGETPLATFORM}-features-${BOT_FEATURES:-release},target=/src/target,sharing=locked \
    find crates apps/site Cargo.toml -type f -exec touch {} + \
    && if [ -n "$BOT_FEATURES" ]; then F="--features $BOT_FEATURES"; else F=""; fi \
    && cargo build --release -p cap-meeting-bot $F \
    && mkdir -p /out && cp target/release/cap-meeting-bot /out/cap-meeting-bot

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg pulseaudio pulseaudio-utils xvfb ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10002 --create-home --home-dir /home/capbot capbot \
    && install -d -o capbot -g capbot -m 0700 /var/lib/cap-bot
ARG CHROME_POLICY=chrome-policy.json
COPY infra/calendar-bot/${CHROME_POLICY} /etc/chromium/policies/managed/cap-bot.json
COPY infra/calendar-bot/entrypoint.sh /usr/local/bin/cap-bot-entrypoint
COPY --from=build /out/cap-meeting-bot /usr/local/bin/cap-meeting-bot
ENV CHROME_PATH=/usr/bin/chromium \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    CAP_BOT_SPOOL_DIR=/var/lib/cap-bot \
    CAP_BOT_PROFILE_DIR=/tmp/cap-bot-profiles \
    CAP_BOT_PULSE_SINK=cap_bot \
    CAP_BOT_CHROME_NO_SANDBOX=1
# Mount a private, durable volume here: audio waiting to upload survives
# restarts and is removed only once the server confirms the meeting.
VOLUME ["/var/lib/cap-bot"]
USER capbot
ENTRYPOINT ["/usr/local/bin/cap-bot-entrypoint"]
