FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/editor-domain/package.json packages/editor-domain/package.json
COPY packages/outbound-http/package.json packages/outbound-http/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/recording/package.json packages/recording/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/transcription/package.json packages/transcription/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN pnpm --filter @cap/web build && \
    pnpm --filter @cap/web exec esbuild scripts/migrate.mjs --bundle --platform=node --format=cjs --outfile=/app/migrate.cjs

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN npm uninstall --global npm
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/db/migrations ./db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/migrate.cjs ./scripts/migrate.cjs
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "node scripts/migrate.cjs && exec node apps/web/server.js"]
