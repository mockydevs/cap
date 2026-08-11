// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  return {
    storage: { sync: { get: vi.fn() } },
    tabs: { create: vi.fn() },
  };
}

let popup: typeof import("../src/popup.firefox.js");
let chromeMock: ReturnType<typeof createChromeMock>;

beforeAll(async () => {
  // popup.firefox.js wires up #record/#library/#save/#server/#status as a
  // side effect of module evaluation, so the DOM and `chrome` mock both need
  // to be in place before it is imported.
  document.body.innerHTML = `
    <input id="server" />
    <button id="record"></button>
    <button id="library"></button>
    <button id="save"></button>
    <p id="status"></p>
  `;
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  chromeMock.storage.sync.get.mockImplementation(
    (defaults: Record<string, unknown>) => Promise.resolve(defaults),
  );

  popup = await import("../src/popup.firefox.js");
});

describe("normalize", () => {
  it("accepts an https URL", () => {
    expect(popup.normalize("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("accepts http on localhost", () => {
    expect(popup.normalize("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  it("accepts http on 127.0.0.1", () => {
    expect(popup.normalize("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("rejects plain http on a non-localhost hostname", () => {
    expect(() => popup.normalize("http://example.com")).toThrow(
      "Use HTTPS (HTTP is allowed only for localhost)",
    );
  });

  it("rejects a URL with a path", () => {
    expect(() => popup.normalize("https://example.com/foo")).toThrow(
      "Enter only the server origin, without a path or credentials",
    );
  });

  it("rejects a URL with a query string", () => {
    expect(() => popup.normalize("https://example.com/?foo=bar")).toThrow(
      "Enter only the server origin, without a path or credentials",
    );
  });

  it("rejects a URL with a hash", () => {
    expect(() => popup.normalize("https://example.com/#foo")).toThrow(
      "Enter only the server origin, without a path or credentials",
    );
  });

  it("rejects a URL with embedded credentials", () => {
    expect(() =>
      popup.normalize("https://user:pass@example.com"),
    ).toThrow("Enter only the server origin, without a path or credentials");
  });

  it("throws for a value that isn't a URL at all", () => {
    expect(() => popup.normalize("not a url")).toThrow();
  });
});

describe("currentServer", () => {
  it("reads and normalizes the stored server URL", async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com",
    });

    await expect(popup.currentServer()).resolves.toBe(
      "https://cap.example.com",
    );
  });

  it("falls back to the default localhost server when nothing is stored", async () => {
    chromeMock.storage.sync.get.mockImplementation(
      (defaults: Record<string, unknown>) => Promise.resolve(defaults),
    );

    await expect(popup.currentServer()).resolves.toBe(
      "http://localhost:3000",
    );
  });
});
