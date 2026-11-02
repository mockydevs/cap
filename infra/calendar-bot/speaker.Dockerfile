# TEST-ONLY synthetic speaker for the controlled live calendar test. Build
# from the repository root:
#   docker build -f infra/calendar-bot/speaker.Dockerfile -t cap-meet-speaker:test .
# Never deployed as a service; root runs it by hand for one pinned meeting.

FROM rust:1.95-bookworm AS build
WORKDIR /src
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
# "test-speaker" always; add ",fake-meet" only for the local fixture test.
ARG SPEAKER_FEATURES="test-speaker"
COPY Cargo.toml Cargo.lock clippy.toml ./
COPY crates crates
COPY apps/site apps/site
RUN cargo build --release -p cap-meeting-bot --bin cap-meet-speaker --features "$SPEAKER_FEATURES"

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg pulseaudio pulseaudio-utils xvfb ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10003 --create-home --home-dir /home/capspk capspk
ARG CHROME_POLICY=chrome-policy.json
COPY infra/calendar-bot/${CHROME_POLICY} /etc/chromium/policies/managed/cap-bot.json
COPY infra/calendar-bot/speaker-entrypoint.sh /usr/local/bin/cap-speaker-entrypoint
# Synthetic speech only (no real person's voice).
COPY crates/meeting-bot/tests/fixtures/speech.ogg /opt/cap-speaker/speech.ogg
COPY --from=build /src/target/release/cap-meet-speaker /usr/local/bin/cap-meet-speaker
ENV CHROME_PATH=/usr/bin/chromium FFMPEG_PATH=/usr/bin/ffmpeg CAP_BOT_CHROME_NO_SANDBOX=1
USER capspk
ENTRYPOINT ["/usr/local/bin/cap-speaker-entrypoint"]
CMD ["--wav", "/opt/cap-speaker/speech.ogg"]
