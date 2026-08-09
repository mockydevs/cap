FROM node:22-bookworm-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @cap/render-worker build
USER node
EXPOSE 8083
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8083/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm","--filter","@cap/render-worker","start"]
