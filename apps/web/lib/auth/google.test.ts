import { afterEach, describe, expect, it, vi } from "vitest";
import { beginGoogleAuthorization } from "./google";

describe("Google authorization", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("creates a state, nonce, and S256 PKCE authorization request", () => {
    vi.stubEnv(
      "GOOGLE_OAUTH_CLIENT_ID",
      "web-client.apps.googleusercontent.com",
    );
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "server-only-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cap.test");
    const result = beginGoogleAuthorization();

    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.url.origin).toBe("https://accounts.google.com");
    expect(result.url.searchParams.get("redirect_uri")).toBe(
      "https://cap.test/api/auth/google/callback",
    );
    expect(result.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.url.searchParams.get("state")).toBe(result.state);
    expect(result.url.toString()).not.toContain("server-only-secret");
  });

  it("fails closed when server credentials are absent", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cap.test");
    expect(() => beginGoogleAuthorization()).toThrow(
      "GOOGLE_OAUTH_NOT_CONFIGURED",
    );
  });
});
