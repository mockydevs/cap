FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @cap/transcription-worker build
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable && groupadd -r cap && useradd -r -g cap cap
WORKDIR /app
COPY --from=build --chown=cap:cap /app /app
USER cap
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8082/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm","--filter","@cap/transcription-worker","start"]
