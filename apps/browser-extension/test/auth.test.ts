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
    permissions: {
      contains: vi.fn(),
      request: vi.fn(),
    },
    __store: store,
  };
}

let auth: typeof import("../src/lib/auth.js");
let chromeMock: ReturnType<typeof createChromeMock>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  fetchMock = vi.fn();
  (globalThis as Record<string, unknown>).fetch = fetchMock;
  auth = await import("../src/lib/auth.js");
});

describe("login", () => {
  it("stores the token and returns the response on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          token: "tok_123",
          expiresInSeconds: 3600,
          user: { id: "u1", email: "person@example.com", displayName: "Person" },
          workspace: { id: "w1", role: "owner" },
        }),
    });

    const result = await auth.login(
      "https://cap.example.com",
      "person@example.com",
      "hunter2",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cap.example.com/api/desktop/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "person@example.com",
          password: "hunter2",
        }),
      }),
    );
    expect(result.token).toBe("tok_123");
    await expect(auth.getToken("https://cap.example.com")).resolves.toEqual({
      token: "tok_123",
      email: "person@example.com",
    });
  });

  it("throws a generic error and never leaks the server error body on failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { code: "SOME_SERVER_DETAIL" } }),
    });

    await expect(
      auth.login("https://cap.example.com", "person@example.com", "wrong"),
    ).rejects.toThrow("Invalid email or password");
  });
});

describe("storeToken", () => {
  it("read-merges so storing a token for one origin never clobbers another origin's token", async () => {
    await auth.storeToken("https://a.example.com", {
      token: "tok_a",
      email: "a@example.com",
    });
    await auth.storeToken("https://b.example.com", {
      token: "tok_b",
      email: "b@example.com",
    });

    await expect(auth.getToken("https://a.example.com")).resolves.toEqual({
      token: "tok_a",
      email: "a@example.com",
    });
    await expect(auth.getToken("https://b.example.com")).resolves.toEqual({
      token: "tok_b",
      email: "b@example.com",
    });
  });

  it("uses chrome.storage.local, never .sync", async () => {
    await auth.storeToken("https://a.example.com", {
      token: "tok_a",
      email: "a@example.com",
    });
    expect(chromeMock.storage.local.set).toHaveBeenCalled();
  });
});

describe("getToken", () => {
  it("returns null when no token is stored for the origin", async () => {
    await expect(auth.getToken("https://nope.example.com")).resolves.toBeNull();
  });
});

describe("clearToken", () => {
  it("removes only the given origin's token, preserving others", async () => {
    await auth.storeToken("https://a.example.com", {
      token: "tok_a",
      email: "a@example.com",
    });
    await auth.storeToken("https://b.example.com", {
      token: "tok_b",
      email: "b@example.com",
    });

    await auth.clearToken("https://a.example.com");

    await expect(auth.getToken("https://a.example.com")).resolves.toBeNull();
    await expect(auth.getToken("https://b.example.com")).resolves.toEqual({
      token: "tok_b",
      email: "b@example.com",
    });
  });
});

describe("logout", () => {
  it("posts to the logout endpoint with a bearer token and always clears the local token", async () => {
    await auth.storeToken("https://a.example.com", {
      token: "tok_a",
      email: "a@example.com",
    });
    fetchMock.mockResolvedValue({ ok: true });

    await auth.logout("https://a.example.com");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://a.example.com/api/desktop/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer tok_a" },
      }),
    );
    await expect(auth.getToken("https://a.example.com")).resolves.toBeNull();
  });

  it("still clears the local token even when the network call throws", async () => {
    await auth.storeToken("https://a.example.com", {
      token: "tok_a",
      email: "a@example.com",
    });
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(auth.logout("https://a.example.com")).resolves.toBeUndefined();
    await expect(auth.getToken("https://a.example.com")).resolves.toBeNull();
  });
});

describe("ensureHostPermission", () => {
  it("returns true without requesting when the permission is already granted", async () => {
    chromeMock.permissions.contains.mockResolvedValue(true);

    await expect(
      auth.ensureHostPermission("https://cap.example.com"),
    ).resolves.toBe(true);

    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://cap.example.com/*"],
    });
    expect(chromeMock.permissions.request).not.toHaveBeenCalled();
  });

  it("requests the permission when not already granted and returns the request's result", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(true);

    await expect(
      auth.ensureHostPermission("https://cap.example.com"),
    ).resolves.toBe(true);

    expect(chromeMock.permissions.request).toHaveBeenCalledWith({
      origins: ["https://cap.example.com/*"],
    });
  });

  it("returns false when the user declines the permission request", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(false);

    await expect(
      auth.ensureHostPermission("https://cap.example.com"),
    ).resolves.toBe(false);
  });
});
