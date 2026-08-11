import { beforeEach, describe, expect, it, vi } from "vitest";

function createChromeMock() {
  const localStore: Record<string, unknown> = {};
  const syncStore: Record<string, unknown> = {
    serverUrl: "https://cap.example.com",
  };
  return {
    storage: {
      sync: {
        get: vi.fn((defaults: Record<string, unknown>) =>
          Promise.resolve({ ...defaults, ...syncStore }),
        ),
      },
      local: {
        get: vi.fn((key: string) =>
          Promise.resolve(key in localStore ? { [key]: localStore[key] } : {}),
        ),
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(localStore, values);
          return Promise.resolve();
        }),
      },
    },
    tabs: {
      create: vi.fn(),
      query: vi.fn(() => Promise.resolve([{ id: 7 }])),
    },
    tabCapture: { getMediaStreamId: vi.fn(() => Promise.resolve("tab-stream-1")) },
    desktopCapture: { chooseDesktopMedia: vi.fn() },
    offscreen: {
      hasDocument: vi.fn(() => Promise.resolve(false)),
      createDocument: vi.fn(() => Promise.resolve()),
    },
    windows: { create: vi.fn(() => Promise.resolve({ id: 42 })) },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    notifications: { create: vi.fn() },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
    },
    contextMenus: {
      removeAll: vi.fn((callback?: () => void) => callback?.()),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    __localStore: localStore,
  };
}

let background: typeof import("../src/background.chromium.js");
let chromeMock: ReturnType<typeof createChromeMock>;

async function withToken(origin: string) {
  chromeMock.__localStore.auth = {
    [origin]: { token: "tok_123", email: "person@example.com" },
  };
}

beforeEach(async () => {
  vi.resetModules();
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  (globalThis as Record<string, unknown>).fetch = vi.fn();
  background = await import("../src/background.chromium.js");
});

function onMessageListener() {
  return chromeMock.runtime.onMessage.addListener.mock.calls[0][0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (value: unknown) => void,
  ) => unknown;
}

describe("resolveStreamId", () => {
  it('resolves a tab stream id via chrome.tabCapture for source "tab"', async () => {
    await expect(background.resolveStreamId("tab")).resolves.toBe("tab-stream-1");
    expect(chromeMock.tabCapture.getMediaStreamId).toHaveBeenCalledWith({
      targetTabId: 7,
    });
  });

  it.each(["screen", "window"] as const)(
    "resolves a %s stream id via chrome.desktopCapture",
    async (source) => {
      chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
        (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
          callback("desktop-stream-1");
        },
      );

      await expect(background.resolveStreamId(source)).resolves.toBe(
        "desktop-stream-1",
      );
      expect(chromeMock.desktopCapture.chooseDesktopMedia).toHaveBeenCalledWith(
        [source],
        { id: 7 },
        expect.any(Function),
      );
    },
  );

  it("resolves to null when the user cancels the native desktopCapture picker", async () => {
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("");
      },
    );

    await expect(background.resolveStreamId("screen")).resolves.toBeNull();
  });

  it('needs no stream id for source "camera-only"', async () => {
    await expect(background.resolveStreamId("camera-only")).resolves.toBeUndefined();
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
  });
});

describe("handleStartRecording", () => {
  it("fails with a sign-in-first error when no token is stored", async () => {
    const result = await background.handleStartRecording({
      source: "tab",
      includeMic: true,
      includeCamera: false,
      title: "My recording",
    });

    expect(result).toEqual({ ok: false, error: "Sign in first" });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["tab", "screen", "window", "camera-only"] as const)(
    "starts capture for source=%s: creates the offscreen doc and messages OFFSCREEN_BEGIN_CAPTURE",
    async (source) => {
      await withToken("https://cap.example.com");
      chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
        (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
          callback("desktop-stream-1");
        },
      );

      const result = await background.handleStartRecording({
        source,
        includeMic: true,
        includeCamera: false,
        title: "My recording",
      });

      expect(result).toEqual({ ok: true });
      expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "offscreen.html",
          reasons: ["DISPLAY_MEDIA", "USER_MEDIA"],
        }),
      );
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "OFFSCREEN_BEGIN_CAPTURE",
          source,
          includeMic: true,
          baseUrl: "https://cap.example.com",
          authorization: "Bearer tok_123",
          title: "My recording",
        }),
      );
      expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "REC" });
    },
  );

  it("does not create a second offscreen document when one already exists", async () => {
    await withToken("https://cap.example.com");
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);

    await background.handleStartRecording({
      source: "camera-only",
      includeMic: false,
      includeCamera: false,
      title: "t",
    });

    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("treats a canceled desktopCapture picker as a silent no-op, not an error", async () => {
    await withToken("https://cap.example.com");
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("");
      },
    );

    const result = await background.handleStartRecording({
      source: "screen",
      includeMic: true,
      includeCamera: false,
      title: "t",
    });

    expect(result).toEqual({ ok: false, canceled: true });
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("opens the controls window and sends CONTROLS_INIT with includeCamera:true for a screen+camera-bubble combo", async () => {
    await withToken("https://cap.example.com");
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("desktop-stream-1");
      },
    );

    await background.handleStartRecording({
      source: "screen",
      includeMic: true,
      includeCamera: true,
      title: "t",
    });

    expect(chromeMock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "controls.html", type: "popup" }),
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONTROLS_INIT", includeCamera: true }),
    );
  });

  it("opens the controls window but with includeCamera:false when source is camera-only (offscreen already owns the camera capture)", async () => {
    await withToken("https://cap.example.com");

    await background.handleStartRecording({
      source: "camera-only",
      includeMic: false,
      includeCamera: false,
      title: "t",
    });

    expect(chromeMock.windows.create).toHaveBeenCalled();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CONTROLS_INIT", includeCamera: false }),
    );
  });

  it("does not open a controls window for a plain screen recording with no camera", async () => {
    await withToken("https://cap.example.com");
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("desktop-stream-1");
      },
    );

    await background.handleStartRecording({
      source: "screen",
      includeMic: true,
      includeCamera: false,
      title: "t",
    });

    expect(chromeMock.windows.create).not.toHaveBeenCalled();
  });
});

describe("message relay", () => {
  it("relays CONTROLS_PAUSE/CONTROLS_RESUME/CONTROLS_STOP to the offscreen document", () => {
    const listener = onMessageListener();

    listener({ type: "CONTROLS_PAUSE" }, {}, vi.fn());
    listener({ type: "CONTROLS_RESUME" }, {}, vi.fn());
    listener({ type: "CONTROLS_STOP" }, {}, vi.fn());

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_PAUSE",
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_RESUME",
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_STOP",
    });
  });
});

describe("upload outcome handling", () => {
  it("clears the badge and relays CONTROLS_RECORDING_LINKED once a controls window is open", async () => {
    await withToken("https://cap.example.com");
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("desktop-stream-1");
      },
    );
    await background.handleStartRecording({
      source: "screen",
      includeMic: true,
      includeCamera: true,
      title: "t",
    });
    chromeMock.runtime.sendMessage.mockClear();
    chromeMock.action.setBadgeText.mockClear();

    const listener = onMessageListener();
    await listener({ type: "OFFSCREEN_UPLOAD_DONE", recordingId: "rec_1" }, {}, vi.fn());

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CONTROLS_RECORDING_LINKED",
      recordingId: "rec_1",
    });
  });

  it("on auth-expired: clears the stored token, sets the '!' badge, and notifies", async () => {
    await withToken("https://cap.example.com");
    chromeMock.desktopCapture.chooseDesktopMedia.mockImplementation(
      (_sources: string[], _tab: unknown, callback: (id: string) => void) => {
        callback("desktop-stream-1");
      },
    );
    await background.handleStartRecording({
      source: "screen",
      includeMic: true,
      includeCamera: false,
      title: "t",
    });

    const listener = onMessageListener();
    listener({ type: "OFFSCREEN_UPLOAD_AUTH_EXPIRED" }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.__localStore.auth?.["https://cap.example.com"]).toBeUndefined();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(chromeMock.notifications.create).toHaveBeenCalled();
  });

  it("on upload failure: clears the badge and notifies with the failure message", async () => {
    const listener = onMessageListener();

    await listener(
      { type: "OFFSCREEN_UPLOAD_FAILED", message: "Could not complete upload" },
      {},
      vi.fn(),
    );

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Could not complete upload" }),
    );
  });

  it("on OFFSCREEN_ERROR: clears the badge and notifies", async () => {
    const listener = onMessageListener();

    await listener({ type: "OFFSCREEN_ERROR", message: "Could not start capture" }, {}, vi.fn());

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Could not start capture" }),
    );
  });
});

describe("context menu / command wiring (ported from the Firefox launcher)", () => {
  it("registers the context menu and command listeners on import", () => {
    expect(chromeMock.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.commands.onCommand.addListener).toHaveBeenCalledTimes(1);
  });

  it("creates the record and library context menu items on install", () => {
    const onInstalled = chromeMock.runtime.onInstalled.addListener.mock
      .calls[0][0] as () => void;

    onInstalled();

    expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-record" }),
    );
    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-library" }),
    );
  });

  it("routes context menu clicks to /library or / depending on the item", async () => {
    const onClicked = chromeMock.contextMenus.onClicked.addListener.mock
      .calls[0][0] as (info: { menuItemId: string }) => void;

    onClicked({ menuItemId: "cap-library" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/library",
    });
  });

  it("opens / when the start-recording command fires", async () => {
    const onCommand = chromeMock.commands.onCommand.addListener.mock
      .calls[0][0] as (command: string) => void;

    onCommand("start-recording");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.tabs.create).toHaveBeenCalledWith({
      url: "https://cap.example.com/",
    });
  });
});
