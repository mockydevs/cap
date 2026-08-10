FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @cap/webhook-worker build
USER node
EXPOSE 8085
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8085/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm","--filter","@cap/webhook-worker","start"]
