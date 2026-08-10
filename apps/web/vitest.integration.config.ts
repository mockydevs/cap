import { defineConfig } from "vitest/config";

/**
 * Requires docker-compose.test.yml running: from the repo root,
 *   docker compose -f docker-compose.test.yml up -d --wait
 *   pnpm --filter @cap/web test:integration
 *   docker compose -f docker-compose.test.yml down
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    setupFiles: ["test/integration/setup-env.ts"],
    // Integration tests share one Postgres/LocalStack; running them
    // concurrently risks cross-test interference over that shared state.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
