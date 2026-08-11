// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortResumableUpload,
  beginResumableUpload,
  type PendingUpload,
} from "./resumable-client";

describe("resumable-client cross-origin config", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ sessionId: "s1", recordingId: "r1", partSizeBytes: 5_000_000 }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes the request with config.baseUrl and adds an authorization header", async () => {
    await beginResumableUpload(
      "title",
      new Blob(["x"], { type: "video/webm" }),
      undefined,
      { baseUrl: "https://cap.example.com", authorization: "Bearer tok123" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cap.example.com/api/upload-sessions");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok123",
    );
  });

  it("defaults to a relative URL with no authorization header when config is omitted", async () => {
    await beginResumableUpload("title", new Blob(["x"], { type: "video/webm" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/upload-sessions");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("applies config to the abort call's DELETE request", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const upload: PendingUpload = {
      sessionId: "s1",
      recordingId: "r1",
      partSizeBytes: 5_000_000,
      blob: new Blob(["x"]),
      completionIdempotencyKey: "idem",
      uploadedParts: [],
    };

    await abortResumableUpload(upload, {
      baseUrl: "https://cap.example.com",
      authorization: "Bearer tok123",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cap.example.com/api/upload-sessions/s1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok123",
    );
  });
});
