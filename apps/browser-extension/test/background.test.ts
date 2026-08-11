import { beforeAll, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  return {
    storage: { sync: { get: vi.fn() } },
    tabs: { create: vi.fn() },
    runtime: { onInstalled: { addListener: vi.fn() } },
    contextMenus: {
      removeAll: vi.fn((callback?: () => void) => callback?.()),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  };
}

let background: typeof import("../src/background.js");
let chromeMock: ReturnType<typeof createChromeMock>;

beforeAll(async () => {
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  // background.js registers its listeners as a side effect of module
  // evaluation, so `chrome` must be in place before it is imported.
  background = await import("../src/background.js");
});

describe("server", () => {
  it("falls back to http://localhost:3000 when nothing is stored", async () => {
    chromeMock.storage.sync.get.mockImplementation(
      (defaults: Record<string, unknown>) => Promise.resolve(defaults),
    );

    await expect(background.server()).resolves.toBe("http://localhost:3000");
  });

  it("strips a single trailing slash from the stored server URL", async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com/",
    });

    await expect(background.server()).resolves.toBe(
      "https://cap.example.com",
    );
  });

  it("leaves a URL without a trailing slash untouched", async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com",
    });

    await expect(background.server()).resolves.toBe(
      "https://cap.example.com",
    );
  });
});

describe("open", () => {
  it("opens a new tab at the server origin joined with the given path", async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com",
    });

    await background.open("/library");

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/library",
    });
  });

  it("uses the default server when none is stored", async () => {
    chromeMock.storage.sync.get.mockImplementation(
      (defaults: Record<string, unknown>) => Promise.resolve(defaults),
    );

    await background.open("/");

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "http://localhost:3000/",
    });
  });
});

describe("event wiring", () => {
  it("registers the context menu and command listeners on import", () => {
    expect(chromeMock.runtime.onInstalled.addListener).toHaveBeenCalledTimes(
      1,
    );
    expect(chromeMock.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(
      1,
    );
    expect(chromeMock.commands.onCommand.addListener).toHaveBeenCalledTimes(1);
  });

  it("creates the record and library context menu items on install", () => {
    const onInstalled = chromeMock.runtime.onInstalled.addListener.mock
      .calls[0][0] as () => void;
    chromeMock.contextMenus.create.mockClear();
    chromeMock.contextMenus.removeAll.mockClear();

    onInstalled();

    expect(chromeMock.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-record" }),
    );
    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-library" }),
    );
  });

  it("routes context menu clicks to /library or / depending on the item", async () => {
    chromeMock.tabs.create.mockClear();
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com",
    });
    const onClicked = chromeMock.contextMenus.onClicked.addListener.mock
      .calls[0][0] as (info: { menuItemId: string }) => void;

    // The handler is fire-and-forget (`void open(...)`), so give its
    // internal awaits a chance to settle before asserting.
    onClicked({ menuItemId: "cap-library" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    onClicked({ menuItemId: "cap-record" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/library",
    });
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/",
    });
  });

  it("opens / when the start-recording command fires", async () => {
    chromeMock.tabs.create.mockClear();
    chromeMock.storage.sync.get.mockResolvedValue({
      serverUrl: "https://cap.example.com",
    });
    const onCommand = chromeMock.commands.onCommand.addListener.mock
      .calls[0][0] as (command: string) => void;

    onCommand("start-recording");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/",
    });
  });

  it("ignores unrelated commands", async () => {
    chromeMock.tabs.create.mockClear();
    const onCommand = chromeMock.commands.onCommand.addListener.mock
      .calls[0][0] as (command: string) => void;

    onCommand("some-other-command");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });
});
