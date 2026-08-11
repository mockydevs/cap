// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const listPendingUploads = vi.fn();
const resumeUpload = vi.fn();
vi.mock("../src/vendor/resumable-client.js", () => ({
  listPendingUploads,
  resumeUpload,
}));

function createChromeMock() {
  const localStore: Record<string, unknown> = {};
  return {
    storage: {
      sync: {
        get: vi.fn((defaults: Record<string, unknown>) =>
          Promise.resolve({ ...defaults, serverUrl: "https://cap.example.com" }),
        ),
        set: vi.fn(() => Promise.resolve()),
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
    permissions: { contains: vi.fn(), request: vi.fn() },
    tabs: { create: vi.fn() },
    runtime: { sendMessage: vi.fn() },
    __localStore: localStore,
  };
}

let popup: typeof import("../src/popup.chromium.js");
let chromeMock: ReturnType<typeof createChromeMock>;

function setDom() {
  document.body.innerHTML = `
    <input id="server" />
    <button id="save"></button>
    <p id="status"></p>
    <button id="library"></button>
    <div id="pending-upload-banner" hidden>
      <button id="resume-upload"></button>
    </div>
    <section id="login-section" hidden>
      <input id="email" />
      <input id="password" />
      <button id="sign-in"></button>
      <button id="sign-in-google"></button>
      <p id="login-status"></p>
    </section>
    <section id="recording-section" hidden>
      <p id="signed-in-as"></p>
      <select id="source">
        <option value="tab">Current Tab</option>
        <option value="screen">Full Screen</option>
        <option value="window">Window</option>
        <option value="camera-only">Camera only</option>
      </select>
      <input id="include-mic" type="checkbox" checked />
      <input id="include-camera" type="checkbox" />
      <input id="title" />
      <button id="start-recording"></button>
      <button id="sign-out"></button>
    </section>
  `;
}

beforeEach(async () => {
  vi.resetModules();
  listPendingUploads.mockReset().mockResolvedValue([]);
  resumeUpload.mockReset();
  setDom();
  chromeMock = createChromeMock();
  (globalThis as Record<string, unknown>).chrome = chromeMock;
  (globalThis as Record<string, unknown>).fetch = vi.fn();
  popup = await import("../src/popup.chromium.js");
  // Let the module's own top-level `void render()` settle before each test
  // asserts, since import evaluation triggers it.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("normalize", () => {
  it("accepts an https URL, same rules as the Firefox popup", () => {
    expect(popup.normalize("https://example.com")).toBe("https://example.com");
  });

  it("rejects plain http on a non-localhost hostname", () => {
    expect(() => popup.normalize("http://example.com")).toThrow(
      "Use HTTPS (HTTP is allowed only for localhost)",
    );
  });
});

describe("render: auth-state-driven conditional sections", () => {
  it("shows the login section and hides recording when signed out", async () => {
    await popup.render();

    expect((document.querySelector("#login-section") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector("#recording-section") as HTMLElement).hidden).toBe(true);
  });

  it("shows the recording section and hides login when signed in", async () => {
    chromeMock.__localStore.auth = {
      "https://cap.example.com": { token: "tok_123", email: "person@example.com" },
    };

    await popup.render();

    expect((document.querySelector("#login-section") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("#recording-section") as HTMLElement).hidden).toBe(false);
    expect(document.querySelector("#signed-in-as")?.textContent).toContain(
      "person@example.com",
    );
  });

  it("shows the pending-upload banner only when there are pending uploads and a token", async () => {
    chromeMock.__localStore.auth = {
      "https://cap.example.com": { token: "tok_123", email: "person@example.com" },
    };
    listPendingUploads.mockResolvedValue([{ sessionId: "s1" }]);

    await popup.render();

    expect((document.querySelector("#pending-upload-banner") as HTMLElement).hidden).toBe(
      false,
    );
  });

  it("hides the pending-upload banner when there is no token even if uploads exist", async () => {
    listPendingUploads.mockResolvedValue([{ sessionId: "s1" }]);

    await popup.render();

    expect((document.querySelector("#pending-upload-banner") as HTMLElement).hidden).toBe(
      true,
    );
  });
});

describe("start-recording payload construction", () => {
  it("sends POPUP_START_RECORDING with the source/checkbox/title inputs and closes the popup", async () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    (document.querySelector("#source") as HTMLSelectElement).value = "screen";
    (document.querySelector("#include-mic") as HTMLInputElement).checked = false;
    (document.querySelector("#include-camera") as HTMLInputElement).checked = true;
    (document.querySelector("#title") as HTMLInputElement).value = "My recording";

    document.querySelector("#start-recording")?.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "POPUP_START_RECORDING",
      source: "screen",
      includeMic: false,
      includeCamera: true,
      title: "My recording",
    });
    expect(closeSpy).toHaveBeenCalled();
  });
});

describe("save button", () => {
  it("saves the server URL and requests the host permission, showing success once granted", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(true);
    (document.querySelector("#server") as HTMLInputElement).value =
      "https://new.example.com";

    document.querySelector("#save")?.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.storage.sync.set).toHaveBeenCalledWith({
      serverUrl: "https://new.example.com",
    });
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({
      origins: ["https://new.example.com/*"],
    });
    expect(document.querySelector("#status")?.textContent).toMatch(/Saved/);
  });

  it("shows a distinct message when the permission request is declined", async () => {
    chromeMock.permissions.contains.mockResolvedValue(false);
    chromeMock.permissions.request.mockResolvedValue(false);
    (document.querySelector("#server") as HTMLInputElement).value =
      "https://new.example.com";

    document.querySelector("#save")?.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector("#status")?.textContent).toMatch(/declined/i);
  });
});
