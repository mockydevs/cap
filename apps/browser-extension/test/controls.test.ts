// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const beginResumableUpload = vi.fn();
const resumeUpload = vi.fn();
vi.mock("../src/vendor/resumable-client.js", () => ({
  beginResumableUpload,
  resumeUpload,
}));

class FakeTrack {
  kind: string;
  stop = vi.fn();
  constructor(kind: string) {
    this.kind = kind;
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  state = "inactive";
  mimeType = "video/webm";
  ondataavailable: ((event: { data: { size: number } }) => void) | undefined;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(public stream: unknown) {}
  start(timeslice: number) {
    this.state = "recording";
    (this as unknown as Record<string, unknown>).timeslice = timeslice;
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    for (const callback of this.listeners.stop ?? [])
      callback({ type: "stop" });
  }
  addEventListener(type: string, callback: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(callback);
  }
}

let controls: typeof import("../src/controls.js");
let getUserMedia: ReturnType<typeof vi.fn>;
let chromeMock: {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
  };
  windows: {
    getCurrent: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
};

beforeEach(async () => {
  vi.resetModules();
  beginResumableUpload.mockReset();
  resumeUpload.mockReset();

  document.body.innerHTML = `
    <video id="camera-preview" hidden></video>
    <p id="controls-status"></p>
    <button id="pause"></button>
    <button id="resume" hidden></button>
    <button id="stop"></button>
  `;

  getUserMedia = vi.fn();
  (globalThis as Record<string, unknown>).navigator = {
    mediaDevices: { getUserMedia },
  };
  (globalThis as Record<string, unknown>).MediaStream = FakeMediaStream;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;

  chromeMock = {
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
    windows: {
      getCurrent: vi.fn(() => Promise.resolve({ id: 99 })),
      remove: vi.fn(() => Promise.resolve()),
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;

  controls = await import("../src/controls.js");
});

describe("init", () => {
  it("starts its own camera capture + MediaRecorder when includeCamera is true", async () => {
    const stream = new FakeMediaStream([new FakeTrack("video")]);
    getUserMedia.mockResolvedValue(stream);

    await controls.init({ includeCamera: true, title: "t" });

    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    const preview = document.querySelector(
      "#camera-preview",
    ) as HTMLVideoElement;
    expect(preview.hidden).toBe(false);
    expect(preview.srcObject).toBe(stream);
  });

  it("does not touch the camera when includeCamera is false", async () => {
    await controls.init({ includeCamera: false, title: "t" });

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("pause / resume", () => {
  it("relays CONTROLS_PAUSE and pauses the camera recorder if present", async () => {
    getUserMedia.mockResolvedValue(
      new FakeMediaStream([new FakeTrack("video")]),
    );
    await controls.init({ includeCamera: true, title: "t" });

    controls.pause();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CONTROLS_PAUSE",
    });
  });

  it("relays CONTROLS_RESUME", async () => {
    controls.resume();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CONTROLS_RESUME",
    });
  });
});

describe("requestStop", () => {
  it("relays CONTROLS_STOP to background", () => {
    controls.requestStop();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "CONTROLS_STOP",
    });
  });
});

describe("onRecordingLinked", () => {
  it("uploads the camera blob linked to the primary recordingId, then closes the window", async () => {
    const stream = new FakeMediaStream([new FakeTrack("video")]);
    getUserMedia.mockResolvedValue(stream);
    await controls.init({
      includeCamera: true,
      title: "My recording",
      baseUrl: "https://cap.example.com",
      authorization: "Bearer tok_123",
    });
    beginResumableUpload.mockResolvedValue({ sessionId: "s1" });
    resumeUpload.mockResolvedValue({ recordingId: "rec_camera" });

    await controls.onRecordingLinked({ recordingId: "rec_primary" });

    expect(beginResumableUpload).toHaveBeenCalledWith(
      "My recording (camera)",
      expect.anything(),
      "rec_primary",
      { baseUrl: "https://cap.example.com", authorization: "Bearer tok_123" },
    );
    expect(chromeMock.windows.getCurrent).toHaveBeenCalled();
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(99);
  });

  it("with no camera, just closes the window without uploading anything", async () => {
    await controls.init({ includeCamera: false, title: "t" });

    await controls.onRecordingLinked({ recordingId: "rec_primary" });

    expect(beginResumableUpload).not.toHaveBeenCalled();
    expect(chromeMock.windows.remove).toHaveBeenCalledWith(99);
  });
});

describe("message dispatch", () => {
  it("routes CONTROLS_INIT and CONTROLS_RECORDING_LINKED from chrome.runtime.onMessage", async () => {
    const listener = chromeMock.runtime.onMessage.addListener.mock
      .calls[0][0] as (message: unknown) => void;
    getUserMedia.mockResolvedValue(
      new FakeMediaStream([new FakeTrack("video")]),
    );

    listener({ type: "CONTROLS_INIT", includeCamera: false, title: "t" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener({ type: "CONTROLS_RECORDING_LINKED", recordingId: "rec_primary" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.windows.remove).toHaveBeenCalledWith(99);
  });
});
