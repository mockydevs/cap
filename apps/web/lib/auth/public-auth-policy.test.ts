import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GET as signupGet,
  POST as signup,
} from "../../app/api/auth/signup/route";
import { POST as login } from "../../app/api/auth/login/route";
import { GET as google } from "../../app/api/auth/google/route";
import { GET as callback } from "../../app/api/auth/google/callback/route";
import { POST as desktopLogin } from "../../app/api/desktop/auth/login/route";
import { POST as desktopGoogle } from "../../app/api/desktop/auth/google/route";
import { GET as desktopGoogleConfig } from "../../app/api/desktop/auth/google/config/route";

describe("public Cap credential closure", () => {
  it.each([
    signupGet,
    signup,
    login,
    google,
    callback,
    desktopLogin,
    desktopGoogle,
    desktopGoogleConfig,
  ])(
    "rejects provisioning without reading credentials or touching a database",
    async (handler) => {
      const response = handler();
      expect(response.status).toBe(410);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: { code: "CALARI_SIGN_IN_REQUIRED" },
        signInUrl: "/portal",
      });
    },
  );
});

describe("local legacy fixture isolation", () => {
  it.each([
    "",
    "postgresql://test:do-not-print@remote.invalid/cap_test",
    "postgresql://test:do-not-print@localhost/production",
    "postgresql://test:do-not-print@localhost/cap_test?host=remote.invalid",
    "https://localhost/cap_test",
  ])(
    "rejects an unsafe database configuration without exposing credentials",
    (databaseUrl) => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../../tests/e2e/seed-legacy-session.mjs",
              import.meta.url,
            ),
          ),
        ],
        {
          input: "{}",
          encoding: "utf8",
          timeout: 5000,
          env: { DATABASE_URL: databaseUrl },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("loopback *_test database");
      expect(result.stderr).not.toContain("do-not-print");
    },
  );
});
