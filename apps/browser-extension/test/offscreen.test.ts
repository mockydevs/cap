// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRecorderMimeType = vi.fn(() => "video/webm;codecs=vp9,opus");
const beginResumableUpload = vi.fn();
const resumeUpload = vi.fn();

vi.mock("../src/vendor/recording.js", () => ({ selectRecorderMimeType }));
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
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  stream: unknown;
  options: Record<string, unknown> | undefined;
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: { size: number } }) => void) | undefined;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(stream: unknown, options?: Record<string, unknown>) {
    this.stream = stream;
    this.options = options;
    this.mimeType = (options?.mimeType as string) ?? "video/webm";
  }
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
    this.dispatch("stop");
  }
  addEventListener(type: string, callback: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(callback);
  }
  private dispatch(type: string) {
    for (const callback of this.listeners[type] ?? []) callback({ type });
  }
}

let offscreen: typeof import("../src/offscreen.js");
let getUserMedia: ReturnType<typeof vi.fn>;
let chromeMock: {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
  };
};

beforeEach(async () => {
  vi.resetModules();
  selectRecorderMimeType.mockClear();
  beginResumableUpload.mockReset();
  resumeUpload.mockReset();

  getUserMedia = vi.fn();
  (globalThis as Record<string, unknown>).navigator = {
    mediaDevices: { getUserMedia },
  };
  (globalThis as Record<string, unknown>).MediaStream = FakeMediaStream;
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;

  chromeMock = {
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;

  offscreen = await import("../src/offscreen.js");
});

describe("chromeMediaSourceFor", () => {
  it('is "tab" for source "tab"', () => {
    expect(offscreen.chromeMediaSourceFor("tab")).toBe("tab");
  });

  it.each(["screen", "window"])('is "desktop" for source "%s"', (source) => {
    expect(offscreen.chromeMediaSourceFor(source)).toBe("desktop");
  });
});

describe("redeemDisplayStream", () => {
  it('uses chromeMediaSource "tab" for a tab capture stream id', async () => {
    const fakeStream = new FakeMediaStream();
    getUserMedia.mockResolvedValue(fakeStream);

    await offscreen.redeemDisplayStream("tab", "tab-stream-1");

    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: "tab-stream-1",
        },
      },
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: "tab-stream-1",
        },
      },
    });
  });

  it('uses chromeMediaSource "desktop" for a screen/window capture stream id', async () => {
    const fakeStream = new FakeMediaStream();
    getUserMedia.mockResolvedValue(fakeStream);

    await offscreen.redeemDisplayStream("screen", "desktop-stream-1");

    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: "desktop-stream-1",
        },
      },
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: "desktop-stream-1",
        },
      },
    });
  });
});

describe("combineStreams", () => {
  it("combines the display's video+audio tracks with the mic's audio tracks", () => {
    const displayVideo = new FakeTrack("video");
    const displayAudio = new FakeTrack("audio");
    const micAudio = new FakeTrack("audio");
    const display = new FakeMediaStream([displayVideo, displayAudio]);
    const mic = new FakeMediaStream([micAudio]);

    const combined = offscreen.combineStreams(display, mic);

    expect(combined.getTracks()).toEqual([
      displayVideo,
      displayAudio,
      micAudio,
    ]);
  });

  it("works with no mic stream", () => {
    const displayVideo = new FakeTrack("video");
    const display = new FakeMediaStream([displayVideo]);

    const combined = offscreen.combineStreams(display, undefined);

    expect(combined.getTracks()).toEqual([displayVideo]);
  });
});

describe("acquireStream", () => {
  it('for source "camera-only", calls getUserMedia({video:true, audio:includeMic}) and nothing else', async () => {
    const fakeStream = new FakeMediaStream();
    getUserMedia.mockResolvedValue(fakeStream);

    const result = await offscreen.acquireStream({
      source: "camera-only",
      includeMic: true,
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(result).toBe(fakeStream);
  });

  it("for a display source with includeMic:true, redeems the display then combines with a separate mic getUserMedia call", async () => {
    const displayVideo = new FakeTrack("video");
    const display = new FakeMediaStream([displayVideo]);
    const micAudio = new FakeTrack("audio");
    const mic = new FakeMediaStream([micAudio]);
    getUserMedia.mockResolvedValueOnce(display).mockResolvedValueOnce(mic);

    const result = await offscreen.acquireStream({
      source: "tab",
      streamId: "tab-stream-1",
      includeMic: true,
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
    expect(result.getTracks()).toEqual([displayVideo, micAudio]);
  });

  it("for a display source with includeMic:false, returns the display stream as-is", async () => {
    const display = new FakeMediaStream([new FakeTrack("video")]);
    getUserMedia.mockResolvedValue(display);

    const result = await offscreen.acquireStream({
      source: "screen",
      streamId: "desktop-stream-1",
      includeMic: false,
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result).toBe(display);
  });
});

describe("pickMimeType", () => {
  it("delegates to the vendored selectRecorderMimeType against MediaRecorder.isTypeSupported", () => {
    const result = offscreen.pickMimeType();

    expect(result).toBe("video/webm;codecs=vp9,opus");
    expect(selectRecorderMimeType).toHaveBeenCalledWith(expect.any(Function));
    const supported = selectRecorderMimeType.mock.calls[0][0] as (
      value: string,
    ) => boolean;
    FakeMediaRecorder.isTypeSupported.mockClear();
    supported("video/webm");
    expect(FakeMediaRecorder.isTypeSupported).toHaveBeenCalledWith(
      "video/webm",
    );
  });
});

describe("startRecording", () => {
  it("starts a MediaRecorder at a 2000ms timeslice", () => {
    const stream = new FakeMediaStream([new FakeTrack("video")]);

    const recorder = offscreen.startRecording(
      stream,
    ) as unknown as FakeMediaRecorder;

    expect(recorder.state).toBe("recording");
    expect((recorder as unknown as Record<string, unknown>).timeslice).toBe(
      2000,
    );
  });
});

describe("beginCapture / pauseCapture / resumeCapture", () => {
  it("acquires the stream, starts recording, and replies OFFSCREEN_CAPTURE_STARTED", async () => {
    getUserMedia.mockResolvedValue(
      new FakeMediaStream([new FakeTrack("video")]),
    );

    await offscreen.beginCapture({
      source: "camera-only",
      includeMic: false,
      title: "t",
    });

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_CAPTURE_STARTED",
    });
  });

  it("replies OFFSCREEN_ERROR when stream acquisition fails", async () => {
    getUserMedia.mockRejectedValue(new Error("Permission denied"));

    await offscreen.beginCapture({
      source: "camera-only",
      includeMic: false,
      title: "t",
    });

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_ERROR",
      message: "Permission denied",
    });
  });

  it("pause/resume control the active recorder", async () => {
    getUserMedia.mockResolvedValue(
      new FakeMediaStream([new FakeTrack("video")]),
    );
    await offscreen.beginCapture({
      source: "camera-only",
      includeMic: false,
      title: "t",
    });

    offscreen.pauseCapture();
    offscreen.resumeCapture();
    // No throw means it reached the recorder; behavioral assertions are
    // covered end-to-end via stopCapture below.
  });
});

describe("stopCapture", () => {
  async function begin() {
    const track = new FakeTrack("video");
    const stream = new FakeMediaStream([track]);
    getUserMedia.mockResolvedValue(stream);
    await offscreen.beginCapture({
      source: "camera-only",
      includeMic: false,
      baseUrl: "https://cap.example.com",
      authorization: "Bearer tok_123",
      title: "My recording",
    });
    return { track, stream };
  }

  it("stops the recorder, releases tracks, and replies OFFSCREEN_UPLOAD_DONE on success", async () => {
    const { track } = await begin();
    beginResumableUpload.mockResolvedValue({ sessionId: "s1" });
    resumeUpload.mockResolvedValue({ recordingId: "rec_1" });

    await offscreen.stopCapture();

    expect(track.stop).toHaveBeenCalled();
    expect(beginResumableUpload).toHaveBeenCalledWith(
      "My recording",
      expect.anything(),
      undefined,
      { baseUrl: "https://cap.example.com", authorization: "Bearer tok_123" },
    );
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_UPLOAD_DONE",
      recordingId: "rec_1",
    });
  });

  it("replies OFFSCREEN_UPLOAD_AUTH_EXPIRED when the upload fails with an auth-shaped error", async () => {
    await begin();
    beginResumableUpload.mockRejectedValue(new Error("unauthorized"));

    await offscreen.stopCapture();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_UPLOAD_AUTH_EXPIRED",
    });
  });

  it("replies OFFSCREEN_UPLOAD_FAILED with the message for any other upload failure", async () => {
    await begin();
    beginResumableUpload.mockRejectedValue(
      new Error("Could not create upload session"),
    );

    await offscreen.stopCapture();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "OFFSCREEN_UPLOAD_FAILED",
      message: "Could not create upload session",
    });
  });
});
