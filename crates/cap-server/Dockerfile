# Cap server (Rust). Build from the repository root:
#   docker build -f crates/cap-server/Dockerfile -t cap-server .
# The Whisper model is not baked in: mount it and set MEETING_WHISPER_MODEL_PATH.

FROM rust:1.95-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Keep builds from starving a shared host; override with --build-arg.
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
ARG TARGETPLATFORM
COPY Cargo.toml Cargo.lock clippy.toml ./
COPY crates crates
COPY apps/site apps/site
# BuildKit caches: the Cargo registry and this service's target dir (per
# toolchain, platform and feature set), so a source or UI change recompiles
# only our crates. Our own files are touched first, so a changed file always
# rebuilds even if its timestamp is older than the cached build (git
# checkouts). The binary is copied out of the cache; the cache never ships.
RUN --mount=type=cache,id=cap-cargo-registry-rust1.95,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=cap-cargo-git-rust1.95,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=cap-server-target-rust1.95-${TARGETPLATFORM}-local-whisper,target=/src/target,sharing=locked \
    find crates apps/site Cargo.toml -type f -exec touch {} + \
    && cargo build --release -p cap-server --features local-whisper \
    && mkdir -p /out && cp target/release/cap-server /out/cap-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 cap
COPY --from=build /out/cap-server /usr/local/bin/cap-server
ENV CAP_SERVER_BIND=0.0.0.0:8787 RUST_LOG=info
USER cap
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/usr/local/bin/cap-server", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/cap-server"]
CMD ["serve"]
