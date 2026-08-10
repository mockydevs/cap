import { afterEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";
import {
  beginGoogleAuthorization,
  exchangeGoogleCode,
  verifyGoogleIdToken,
} from "./google";

vi.mock("jose", () => ({
  createRemoteJWKSet: () => async () => ({}),
  jwtVerify: vi.fn(),
}));

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

describe("Google ID token verification", () => {
  const mockedJwtVerify = vi.mocked(jwtVerify);
  afterEach(() => mockedJwtVerify.mockReset());

  it("accepts a verified token and normalizes the email", async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "12345",
        email: "User@Example.com",
        email_verified: true,
        name: "A User",
        nonce: "expected-nonce",
      },
    } as never);
    const identity = await verifyGoogleIdToken(
      "token",
      "client-id",
      "expected-nonce",
    );
    expect(identity).toEqual({
      subject: "12345",
      email: "user@example.com",
      displayName: "A User",
    });
  });

  it("falls back to the email's local part when no name is present", async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: { sub: "1", email: "a@example.com", email_verified: true },
    } as never);
    const identity = await verifyGoogleIdToken("token", "client-id");
    expect(identity.displayName).toBe("a");
  });

  it("rejects a nonce that doesn't match the one issued for this flow", async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "1",
        email: "a@example.com",
        email_verified: true,
        nonce: "wrong",
      },
    } as never);
    await expect(
      verifyGoogleIdToken("token", "client-id", "expected"),
    ).rejects.toThrow("GOOGLE_NONCE_MISMATCH");
  });

  it("rejects an unverified email even with a valid signature", async () => {
    mockedJwtVerify.mockResolvedValueOnce({
      payload: { sub: "1", email: "a@example.com", email_verified: false },
    } as never);
    await expect(verifyGoogleIdToken("token", "client-id")).rejects.toThrow(
      "GOOGLE_IDENTITY_UNVERIFIED",
    );
  });

  it("propagates signature/issuer/audience failures from jose", async () => {
    mockedJwtVerify.mockRejectedValueOnce(new Error("signature verification failed"));
    await expect(verifyGoogleIdToken("token", "client-id")).rejects.toThrow(
      "signature verification failed",
    );
  });
});

describe("Google authorization code exchange", () => {
  const mockedJwtVerify = vi.mocked(jwtVerify);
  afterEach(() => {
    mockedJwtVerify.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubEnv() {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "web-client.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "server-only-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cap.test");
  }

  it("rejects a non-OK token endpoint response", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(
      exchangeGoogleCode({ code: "c", verifier: "v", nonce: "n" }),
    ).rejects.toThrow("GOOGLE_CODE_EXCHANGE_FAILED");
  });

  it("rejects a response missing an id_token", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    await expect(
      exchangeGoogleCode({ code: "c", verifier: "v", nonce: "n" }),
    ).rejects.toThrow("GOOGLE_ID_TOKEN_MISSING");
  });

  it("verifies the returned id_token against the request's own nonce", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id_token: "returned-token" }),
      }),
    );
    mockedJwtVerify.mockResolvedValueOnce({
      payload: {
        sub: "1",
        email: "a@example.com",
        email_verified: true,
        nonce: "n",
      },
    } as never);
    const identity = await exchangeGoogleCode({
      code: "c",
      verifier: "v",
      nonce: "n",
    });
    expect(identity.subject).toBe("1");
    expect(mockedJwtVerify).toHaveBeenCalledWith(
      "returned-token",
      expect.anything(),
      expect.objectContaining({ audience: "web-client.apps.googleusercontent.com" }),
    );
  });
});
