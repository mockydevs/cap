FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @cap/ai-worker build
USER node
EXPOSE 8084
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8084/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["apps/ai-worker/node_modules/.bin/tsx","apps/ai-worker/src/index.ts"]
