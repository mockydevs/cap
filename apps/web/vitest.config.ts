import { configDefaults, defineConfig } from "vitest/config";

/**
 * Governs `pnpm --filter @cap/web test` (and `turbo test`). Integration
 * tests need a live Postgres and LocalStack (docker-compose.test.yml) and
 * run only via `pnpm --filter @cap/web test:integration`, which uses
 * vitest.integration.config.ts instead — kept out of the default run so it
 * stays fast and infra-free.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
