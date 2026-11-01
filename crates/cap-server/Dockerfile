# Cap server (Rust). Build from the repository root:
#   docker build -f crates/cap-server/Dockerfile -t cap-server .
# The Whisper model is not baked in: mount it and set MEETING_WHISPER_MODEL_PATH.

FROM rust:1.95-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Keep builds from starving a shared host; override with --build-arg.
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
COPY Cargo.toml Cargo.lock clippy.toml ./
COPY crates crates
RUN cargo build --release -p cap-server --features local-whisper

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 cap
COPY --from=build /src/target/release/cap-server /usr/local/bin/cap-server
COPY apps/site /srv/site
ENV CAP_SERVER_BIND=0.0.0.0:8787 CAP_SITE_DIR=/srv/site RUST_LOG=info
USER cap
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/usr/local/bin/cap-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/cap-server"]
CMD ["serve"]
