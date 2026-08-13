import { beforeEach, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  const store: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: vi.fn((key: string) =>
          Promise.resolve(key in store ? { [key]: store[key] } : {}),
        ),
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(store, values);
          return Promise.resolve();
        }),
      },
    },
    identity: {
      getRedirectURL: vi.fn(
        () => "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/",
      ),
      launchWebAuthFlow: vi.fn(),
    },
  };
}

let googleAuth: typeof import("../src/lib/google-auth.js");
let auth: typeof import("../src/lib/auth.js");
let chromeMock: ReturnType<typeof createChromeMock>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  fetchMock = vi.fn();
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  googleAuth = await import("../src/lib/google-auth.js");
  auth = await import("../src/lib/auth.js");
});

describe("generateNonce", () => {
  it("produces a nonce exactly 43 characters long and matching the server's regex", () => {
    for (let i = 0; i < 20; i += 1) {
      const nonce = googleAuth.generateNonce();
      expect(nonce).toHaveLength(43);
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("buildAuthUrl", () => {
  it("builds the Google OAuth URL with the expected query params", () => {
    const url = new URL(
      googleAuth.buildAuthUrl(
        "client-123.apps.googleusercontent.com",
        "a".repeat(43),
      ),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "client-123.apps.googleusercontent.com",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/",
    );
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBe("a".repeat(43));
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("extractIdToken", () => {
  it("parses the id_token out of a fake launchWebAuthFlow redirect URL", () => {
    const responseUrl =
      "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/#id_token=eyFakeToken&state=xyz";

    expect(googleAuth.extractIdToken(responseUrl)).toBe("eyFakeToken");
  });

  it("returns null when there is no id_token fragment param", () => {
    const responseUrl =
      "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/#state=xyz";

    expect(googleAuth.extractIdToken(responseUrl)).toBeNull();
  });
});

describe("signInWithGoogle", () => {
  it("throws a clear error when the server hasn't configured Google sign-in (503)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: () =>
        Promise.resolve({
          error: { code: "GOOGLE_DESKTOP_OAUTH_NOT_CONFIGURED" },
        }),
    });

    await expect(
      googleAuth.signInWithGoogle("https://cap.example.com"),
    ).rejects.toThrow("Google sign-in is not configured on this server");
    expect(chromeMock.identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("completes the flow: config -> auth url -> POST body shape -> stored token", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/desktop/auth/google/config")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clientId: "client-123" }),
        });
      }
      if (url.endsWith("/api/desktop/auth/google")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ token: "tok_google", displayName: "Person" }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    chromeMock.identity.launchWebAuthFlow.mockImplementation(
      ({ url }: { url: string }) => {
        const nonce = new URL(url).searchParams.get("nonce");
        return Promise.resolve(
          `https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/#id_token=fake-id-token&state=${nonce}`,
        );
      },
    );

    await googleAuth.signInWithGoogle("https://cap.example.com");

    const googleCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/api/desktop/auth/google"),
    );
    expect(googleCall).toBeDefined();
    const [, init] = googleCall!;
    const body = JSON.parse(init.body as string);
    expect(body.idToken).toBe("fake-id-token");
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(auth.getToken("https://cap.example.com")).resolves.toEqual({
      token: "tok_google",
      email: "Person",
    });
  });

  it("throws when launchWebAuthFlow rejects (user closed the window)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ clientId: "client-123" }),
    });
    chromeMock.identity.launchWebAuthFlow.mockRejectedValue(
      new Error("User closed the window"),
    );

    await expect(
      googleAuth.signInWithGoogle("https://cap.example.com"),
    ).rejects.toThrow("Google sign-in was canceled");
  });

  it("throws when the redirect has no id_token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ clientId: "client-123" }),
    });
    chromeMock.identity.launchWebAuthFlow.mockResolvedValue(
      "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/#error=access_denied",
    );

    await expect(
      googleAuth.signInWithGoogle("https://cap.example.com"),
    ).rejects.toThrow("Google sign-in did not return an ID token");
  });

  it("throws a generic error when the server rejects the id token", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/config"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ clientId: "client-123" }),
        });
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({ error: { code: "GOOGLE_AUTHENTICATION_FAILED" } }),
      });
    });
    chromeMock.identity.launchWebAuthFlow.mockResolvedValue(
      "https://abcdefabcdefabcdefabcdefabcdefab.chromiumapp.org/#id_token=fake",
    );

    await expect(
      googleAuth.signInWithGoogle("https://cap.example.com"),
    ).rejects.toThrow("Google sign-in failed");
  });
});
