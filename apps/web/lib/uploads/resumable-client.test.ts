// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortResumableUpload,
  beginResumableUpload,
  pendingUploadProgress,
  type PendingUpload,
} from "./resumable-client";

describe("resumable-client cross-origin config", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: "s1",
            recordingId: "r1",
            partSizeBytes: 5_000_000,
          }),
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
    await beginResumableUpload(
      "title",
      new Blob(["x"], { type: "video/webm" }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/upload-sessions");
    expect(
      (init.headers as Record<string, string>).authorization,
    ).toBeUndefined();
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

describe("pendingUploadProgress", () => {
  it("reports byte-accurate progress for resumable uploads", () => {
    const upload: PendingUpload = {
      sessionId: "s-progress",
      recordingId: "r-progress",
      partSizeBytes: 5,
      blob: new Blob(["1234567890"]),
      completionIdempotencyKey: "idem-progress",
      uploadedParts: [
        {
          partNumber: 1,
          etag: "etag-1",
          checksumSha256: "checksum-1",
          contentLength: 4,
          isFinalPart: false,
        },
      ],
    };

    expect(pendingUploadProgress(upload)).toEqual({
      completedBytes: 4,
      totalBytes: 10,
      percent: 40,
    });
  });

  it("never reports more than 100 percent", () => {
    const upload: PendingUpload = {
      sessionId: "s-over",
      recordingId: "r-over",
      partSizeBytes: 5,
      blob: new Blob(["12345"]),
      completionIdempotencyKey: "idem-over",
      uploadedParts: [
        {
          partNumber: 1,
          etag: "etag-1",
          checksumSha256: "checksum-1",
          contentLength: 6,
          isFinalPart: true,
        },
      ],
    };

    expect(pendingUploadProgress(upload).percent).toBe(100);
  });
});
