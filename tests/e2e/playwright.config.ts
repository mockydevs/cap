import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Requires the full stack running (docker-compose.yml services + the web
 * app) since these are real browser tests against real auth/DB-backed
 * flows, not mocks. See tests/e2e/README.md.
 */
export default defineConfig({
  testDir: "./specs",
  fullyParallel: !process.env.CI,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: "pnpm --filter @cap/web dev",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          cwd: "../..",
        },
      }),
});
