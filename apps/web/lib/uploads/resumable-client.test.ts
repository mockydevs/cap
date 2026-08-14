// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortResumableUpload,
  beginResumableUpload,
  beginStreamingUpload,
  listPendingUploads,
  pendingUploadProgress,
  resumeUpload,
  declaredContentType,
  type PendingUpload,
} from "./resumable-client";

describe("upload-during-recording", () => {
  const originalArrayBuffer = Blob.prototype.arrayBuffer;

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    if (!Blob.prototype.arrayBuffer)
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        value: function (this: Blob) {
          return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () =>
              resolve(reader.result as ArrayBuffer),
            );
            reader.addEventListener("error", () => reject(reader.error));
            reader.readAsArrayBuffer(this);
          });
        },
      });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (!originalArrayBuffer)
      delete (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer;
  });

  it("uploads full parts in the background and leaves only a sub-part tail", async () => {
    const signedFinalFlags: boolean[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload-sessions") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          streaming: true,
          contentType: "video/webm",
        });
        return Response.json(
          { sessionId: "s-live", recordingId: "r-live", partSizeBytes: 5 },
          { status: 201 },
        );
      }
      const part = /\/parts\/(\d+)$/.exec(url);
      if (part && init?.method === "PATCH")
        return Response.json({ status: "ACKNOWLEDGED" });
      if (part) {
        signedFinalFlags.push(
          (JSON.parse(String(init?.body)) as { isFinalPart: boolean })
            .isFinalPart,
        );
        return Response.json({
          url: `https://storage.example/live-${part[1]}`,
          method: "PUT",
          requiredHeaders: {},
        });
      }
      if (url.startsWith("https://storage.example/live-"))
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${url.at(-1)}"` },
        });
      if (url === "/api/upload-sessions/s-live" && init?.method === "PATCH")
        return Response.json({ status: "REPORTED" });
      if (url.endsWith("/complete"))
        return Response.json({
          recordingId: "r-live",
          status: "PROCESSING",
          sizeBytes: 6,
        });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const upload = await beginStreamingUpload("Live", "video/webm");
    const progress = await upload.append(
      new Blob(["123456"], { type: "video/webm" }),
    );

    expect(progress).toEqual({ recordedBytes: 6, uploadedBytes: 0 });

    await upload.finish();
    expect(signedFinalFlags).toEqual([false, true]);
  });

  it("seals an exact-multiple recording without uploading a duplicate tail", async () => {
    const finalFlags: boolean[] = [];
    let sealed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload-sessions")
        return Response.json(
          { sessionId: "s-exact", recordingId: "r-exact", partSizeBytes: 5 },
          { status: 201 },
        );
      if (url === "/api/upload-sessions/s-exact" && init?.method === "PATCH") {
        sealed ||= Boolean(
          (JSON.parse(String(init.body)) as { sealed?: boolean }).sealed,
        );
        return Response.json({ status: sealed ? "SEALED" : "REPORTED" });
      }
      const part = /\/parts\/(\d+)$/.exec(url);
      if (part && init?.method === "PATCH")
        return Response.json({ status: "ACKNOWLEDGED" });
      if (part) {
        finalFlags.push(
          (JSON.parse(String(init?.body)) as { isFinalPart: boolean })
            .isFinalPart,
        );
        return Response.json({
          url: `https://storage.example/exact-${part[1]}`,
          method: "PUT",
          requiredHeaders: {},
        });
      }
      if (url.startsWith("https://storage.example/exact-"))
        return new Response(null, {
          status: 200,
          headers: { ETag: '"exact-etag"' },
        });
      if (url.endsWith("/complete"))
        return Response.json({
          recordingId: "r-exact",
          status: "PROCESSING",
          sizeBytes: 5,
        });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const upload = await beginStreamingUpload("Exact", "video/webm");
    await upload.append(new Blob(["12345"], { type: "video/webm" }));
    expect(
      (await listPendingUploads()).find(
        (pending) => pending.sessionId === "s-exact",
      )?.blob.size,
    ).toBe(5);
    await upload.finish();

    expect(finalFlags).toEqual([false]);
    expect(sealed).toBe(true);
  });

  it("keeps multiple live storage PUTs in flight", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload-sessions")
        return Response.json(
          {
            sessionId: "s-concurrent",
            recordingId: "r-concurrent",
            partSizeBytes: 5,
          },
          { status: 201 },
        );
      if (
        url === "/api/upload-sessions/s-concurrent" &&
        init?.method === "PATCH"
      )
        return Response.json({ status: "REPORTED" });
      const part = /\/parts\/(\d+)$/.exec(url);
      if (part && init?.method === "PATCH")
        return Response.json({ status: "ACKNOWLEDGED" });
      if (part)
        return Response.json({
          url: `https://storage.example/concurrent-${part[1]}`,
          method: "PUT",
          requiredHeaders: {},
        });
      const stored = /storage\.example\/concurrent-(\d+)$/.exec(url);
      if (stored) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${stored[1]}"` },
        });
      }
      if (url.endsWith("/complete"))
        return Response.json({
          recordingId: "r-concurrent",
          status: "PROCESSING",
          sizeBytes: 16,
        });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const upload = await beginStreamingUpload("Concurrent", "video/webm");
    await upload.append(new Blob(["1234567890123456"], { type: "video/webm" }));
    await upload.finish();

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

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

describe("stale multipart recovery", () => {
  const originalArrayBuffer = Blob.prototype.arrayBuffer;

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    if (!Blob.prototype.arrayBuffer)
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        value: async () => new Uint8Array([120]).buffer,
      });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (!originalArrayBuffer)
      delete (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer;
  });

  it("rotates a missing provider session and finishes with the preserved blob", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          url: "https://storage.example/old-part",
          method: "PUT",
          requiredHeaders: {},
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            sessionId: "s-new",
            recordingId: "r1",
            partSizeBytes: 5_000_000,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          url: "https://storage.example/new-part",
          method: "PUT",
          requiredHeaders: {},
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { ETag: '"fresh"' } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          recordingId: "r1",
          status: "PROCESSING",
          sizeBytes: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await resumeUpload({
      sessionId: "s-old",
      recordingId: "r1",
      partSizeBytes: 5_000_000,
      blob: new Blob(["x"], { type: "video/webm" }),
      completionIdempotencyKey: "idem-old",
      uploadedParts: [],
    });

    expect(result).toMatchObject({ recordingId: "r1", status: "PROCESSING" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/upload-sessions/s-old/parts/1",
      "https://storage.example/old-part",
      "/api/upload-sessions/s-old/restart",
      "/api/upload-sessions/s-new/parts/1",
      "https://storage.example/new-part",
      "/api/upload-sessions/s-new/complete",
    ]);
  });

  it("does not loop when the replacement session is also missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          url: "https://storage.example/old-part",
          method: "PUT",
          requiredHeaders: {},
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            sessionId: "s-new",
            recordingId: "r1",
            partSizeBytes: 5_000_000,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          url: "https://storage.example/new-part",
          method: "PUT",
          requiredHeaders: {},
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resumeUpload({
        sessionId: "s-old",
        recordingId: "r1",
        partSizeBytes: 5_000_000,
        blob: new Blob(["x"], { type: "video/webm" }),
        completionIdempotencyKey: "idem-old",
        uploadedParts: [],
      }),
    ).rejects.toThrow("Storage rejected upload part (HTTP 404)");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("seals an already-uploaded exact streaming boundary on resume", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/upload-sessions/s-boundary" && init?.method === "PATCH")
        return Response.json({ status: "SEALED" });
      if (url.endsWith("/complete"))
        return Response.json({
          recordingId: "r-boundary",
          status: "PROCESSING",
          sizeBytes: 5,
        });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await resumeUpload({
      sessionId: "s-boundary",
      recordingId: "r-boundary",
      partSizeBytes: 5,
      blob: new Blob(["12345"], { type: "video/webm" }),
      completionIdempotencyKey: "idem-boundary-123456",
      uploadedParts: [
        {
          partNumber: 1,
          etag: '"etag-boundary"',
          checksumSha256: "checksum-boundary",
          contentLength: 5,
          isFinalPart: false,
        },
      ],
      streaming: true,
      recordedBytes: 5,
    });

    expect(calls).toEqual([
      "PATCH /api/upload-sessions/s-boundary",
      "POST /api/upload-sessions/s-boundary/complete",
    ]);
  });
});

describe("parallel part uploads", () => {
  const originalArrayBuffer = Blob.prototype.arrayBuffer;

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    if (!Blob.prototype.arrayBuffer)
      Object.defineProperty(Blob.prototype, "arrayBuffer", {
        configurable: true,
        value: async () => new Uint8Array([120]).buffer,
      });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (!originalArrayBuffer)
      delete (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer;
  });

  /**
   * Signs and stores every part, holding each storage PUT open until released so
   * a test can observe how many are in flight at once. `partDelays` decides the
   * order they finish in.
   */
  function storageHarness(partDelays: Record<number, number> = {}) {
    let inFlight = 0;
    let peakInFlight = 0;
    const completedOrder: number[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const partMatch = /\/parts\/(\d+)$/.exec(url);
      if (partMatch)
        return Response.json({
          url: `https://storage.example/part-${partMatch[1]}`,
          method: "PUT",
          requiredHeaders: {},
        });

      const storageMatch = /storage\.example\/part-(\d+)$/.exec(url);
      if (storageMatch) {
        const partNumber = Number(storageMatch[1]);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) =>
          setTimeout(resolve, partDelays[partNumber] ?? 0),
        );
        inFlight -= 1;
        completedOrder.push(partNumber);
        return new Response(null, {
          status: 200,
          headers: { ETag: `"etag-${partNumber}"` },
        });
      }

      if (url.endsWith("/complete"))
        return Response.json({
          recordingId: "r1",
          status: "PROCESSING",
          sizeBytes: 10,
          manifest: JSON.parse(String(init?.body)),
        });

      throw new Error(`unexpected request: ${url}`);
    });

    return {
      fetchMock,
      peak: () => peakInFlight,
      completedOrder,
      completionParts: () => {
        const call = fetchMock.mock.calls.find(([requestUrl]) =>
          String(requestUrl).endsWith("/complete"),
        );
        return (
          JSON.parse(String((call?.[1] as RequestInit).body)) as {
            parts: { partNumber: number }[];
          }
        ).parts;
      },
    };
  }

  const fivePartUpload = (): PendingUpload => ({
    sessionId: "s-parallel",
    recordingId: "r1",
    partSizeBytes: 2,
    blob: new Blob(["0123456789"], { type: "video/webm" }),
    completionIdempotencyKey: "idem-parallel",
    uploadedParts: [],
  });

  it("keeps several parts in flight instead of one at a time", async () => {
    const harness = storageHarness({ 1: 20, 2: 20, 3: 20, 4: 20, 5: 20 });
    vi.stubGlobal("fetch", harness.fetchMock);

    await resumeUpload(fivePartUpload(), undefined, { concurrency: 4 });

    expect(harness.peak()).toBeGreaterThan(1);
    expect(harness.peak()).toBeLessThanOrEqual(4);
  });

  it("holds one part in flight when concurrency is 1, as it used to", async () => {
    const harness = storageHarness({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10 });
    vi.stubGlobal("fetch", harness.fetchMock);

    await resumeUpload(fivePartUpload(), undefined, { concurrency: 1 });

    expect(harness.peak()).toBe(1);
    expect(harness.completedOrder).toEqual([1, 2, 3, 4, 5]);
  });

  it("sends the completion manifest in ascending order when parts finish out of order", async () => {
    // Part 1 is slowest, so it lands last and insertion order is not part order.
    const harness = storageHarness({ 1: 40, 2: 30, 3: 20, 4: 10, 5: 0 });
    vi.stubGlobal("fetch", harness.fetchMock);

    await resumeUpload(fivePartUpload(), undefined, { concurrency: 5 });

    expect(harness.completedOrder[0]).not.toBe(1);
    expect(harness.completionParts().map((part) => part.partNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("uploads only the parts that are still missing on resume", async () => {
    const harness = storageHarness();
    vi.stubGlobal("fetch", harness.fetchMock);

    await resumeUpload(
      {
        ...fivePartUpload(),
        uploadedParts: [
          {
            partNumber: 2,
            etag: '"etag-2"',
            checksumSha256: "checksum-2",
            contentLength: 2,
            isFinalPart: false,
          },
        ],
      },
      undefined,
      { concurrency: 4 },
    );

    expect(harness.completedOrder.sort()).toEqual([1, 3, 4, 5]);
    expect(harness.completionParts().map((part) => part.partNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("still restarts the session when storage has forgotten it", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (/\/parts\/\d+$/.test(url))
        return Response.json({
          url: `https://storage.example/gone`,
          method: "PUT",
          requiredHeaders: {},
        });
      if (url.endsWith("/gone")) return new Response(null, { status: 404 });
      if (url.endsWith("/restart"))
        return Response.json(
          { sessionId: "s-new", recordingId: "r1", partSizeBytes: 2 },
          { status: 201 },
        );
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // The replacement session is missing too, which must not loop.
    await expect(
      resumeUpload(fivePartUpload(), undefined, { concurrency: 3 }),
    ).rejects.toThrow("Storage rejected upload part (HTTP 404)");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/restart")),
    ).toHaveLength(1);
  });
});

describe("declaredContentType", () => {
  it("reads the container out of the type MediaRecorder negotiated", () => {
    expect(
      declaredContentType(
        new Blob([], { type: "video/mp4;codecs=avc1.42E01E,mp4a.40.2" }),
      ),
    ).toBe("video/mp4");
    expect(
      declaredContentType(new Blob([], { type: "video/webm;codecs=vp9,opus" })),
    ).toBe("video/webm");
  });

  it("treats a bare or unknown type as WebM", () => {
    expect(declaredContentType(new Blob([], { type: "video/mp4" }))).toBe(
      "video/mp4",
    );
    expect(declaredContentType(new Blob([]))).toBe("video/webm");
  });
});
