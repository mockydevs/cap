FROM node:22-bookworm-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @cap/render-worker build
USER node
EXPOSE 8083
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8083/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["apps/render-worker/node_modules/.bin/tsx","apps/render-worker/src/index.ts"]
