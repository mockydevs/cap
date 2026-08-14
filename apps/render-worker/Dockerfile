FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile && \
    pnpm --filter @cap/render-worker build && \
    pnpm --filter @cap/render-worker deploy --prod --legacy /runtime

FROM node:22-bookworm-slim AS runner
RUN apt-get update && \
    apt-get install --yes --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/* && \
    npm uninstall --global npm
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8083/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
