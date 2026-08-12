FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/media-worker/package.json apps/media-worker/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/ai/package.json packages/ai/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS runner
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY apps/media-worker apps/media-worker
COPY packages/queue packages/queue
COPY packages/ai packages/ai
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8081/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["apps/media-worker/node_modules/.bin/tsx", "apps/media-worker/src/index.ts"]
