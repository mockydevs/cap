"use client";

const DATABASE_NAME = "cap-upload-queue";
const STORE_NAME = "uploads";

export type UploadedPart = {
  partNumber: number;
  etag: string;
  checksumSha256: string;
  contentLength: number;
  isFinalPart: boolean;
};

export type PendingUpload = {
  sessionId: string;
  recordingId: string;
  partSizeBytes: number;
  blob: Blob;
  completionIdempotencyKey: string;
  uploadedParts: UploadedPart[];
  /** Size is sealed by the final part because capture began before it was known. */
  streaming?: boolean;
};

const DEFAULT_UPLOAD_CONCURRENCY = 4;

/**
 * MediaRecorder reports the full type it negotiated — "video/mp4;codecs=avc1…"
 * — while the API takes the bare container. Comparing the whole string against
 * "video/mp4" silently labelled every MP4 recording as WebM, which storage then
 * served under the wrong content type.
 */
export function declaredContentType(blob: Blob): "video/mp4" | "video/webm" {
  return blob.type.split(";")[0]!.trim().toLowerCase() === "video/mp4"
    ? "video/mp4"
    : "video/webm";
}

/**
 * Storage requires the completion manifest in ascending part order, and a Map
 * hands back insertion order — which stopped being part order once parts began
 * finishing out of sequence.
 */
function sortedParts(parts: Map<number, UploadedPart>): UploadedPart[] {
  return [...parts.values()].sort((a, b) => a.partNumber - b.partNumber);
}

export function pendingUploadProgress(upload: PendingUpload): {
  completedBytes: number;
  totalBytes: number;
  percent: number;
} {
  const completedBytes = upload.uploadedParts.reduce(
    (total, part) => total + (part.contentLength || 0),
    0,
  );
  const totalBytes = upload.blob.size;
  return {
    completedBytes,
    totalBytes,
    percent:
      totalBytes === 0
        ? 0
        : Math.min(100, Math.round((completedBytes / totalBytes) * 100)),
  };
}

/**
 * Lets a non-same-origin caller (e.g. the browser extension's background/
 * offscreen contexts, which have no same-origin Cap page to inherit a base
 * URL or session cookie from) point these Cap-API calls at an absolute
 * server origin and authenticate with a bearer token instead of a cookie.
 * Never applied to the presigned S3 PUT itself, which is already absolute
 * and must not carry Cap's Authorization header.
 */
export type UploadClientConfig = {
  baseUrl?: string;
  authorization?: string;
  /** Parts in flight at once. Defaults to 4; 1 restores serial uploads. */
  concurrency?: number;
};

function uploadConcurrency(config: UploadClientConfig | undefined): number {
  const configured = config?.concurrency;
  return Number.isInteger(configured) && configured! > 0
    ? configured!
    : DEFAULT_UPLOAD_CONCURRENCY;
}

function apiUrl(config: UploadClientConfig | undefined, path: string): string {
  return `${config?.baseUrl ?? ""}${path}`;
}

function apiHeaders(
  config: UploadClientConfig | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  return config?.authorization
    ? { ...extra, authorization: config.authorization }
    : extra;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(upload: PendingUpload) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(upload);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function remove(sessionId: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(sessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function replace(
  previousSessionId: string,
  upload: PendingUpload,
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(upload);
    store.delete(previousSessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function listPendingUploads(): Promise<PendingUpload[]> {
  const database = await openDatabase();
  const uploads = await new Promise<PendingUpload[]>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME)
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () => resolve(request.result as PendingUpload[]);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return uploads;
}

async function checksumSha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: { code?: string } } | undefined;
  return new Error(payload?.error?.code ?? fallback);
}

/** Persists the source Blob before the first part is uploaded so reloads can resume. */
export async function beginResumableUpload(
  title: string,
  blob: Blob,
  linkedRecordingId?: string,
  config?: UploadClientConfig,
): Promise<PendingUpload> {
  const response = await fetch(apiUrl(config, "/api/upload-sessions"), {
    method: "POST",
    headers: apiHeaders(config, { "content-type": "application/json" }),
    body: JSON.stringify({
      title,
      contentType: declaredContentType(blob),
      sizeBytes: blob.size,
      ...(linkedRecordingId ? { linkedRecordingId } : {}),
    }),
  });
  if (!response.ok)
    throw await responseError(response, "Could not create upload session");
  const payload = (await response.json()) as {
    sessionId: string;
    recordingId: string;
    partSizeBytes: number;
  };
  const upload: PendingUpload = {
    ...payload,
    blob,
    completionIdempotencyKey: crypto.randomUUID(),
    uploadedParts: [],
  };
  await write(upload);
  return upload;
}

export type StreamingUploadProgress = {
  recordedBytes: number;
  uploadedBytes: number;
};

export type StreamingUploadController = {
  readonly recordingId: string;
  readonly sessionId: string;
  append(chunk: Blob): Promise<StreamingUploadProgress>;
  finish(
    onProgress?: (completedBytes: number, totalBytes: number) => void,
  ): Promise<{ recordingId: string; status: "PROCESSING"; sizeBytes: number }>;
  snapshot(): PendingUpload;
};

/**
 * Starts an upload before MediaRecorder knows the final Blob size. Each chunk is
 * durably folded into the IndexedDB snapshot first. Complete fixed-size parts
 * are then sent in the background, while one tail part is deliberately held
 * back so it can be declared final when recording stops.
 */
export async function beginStreamingUpload(
  title: string,
  contentType: "video/mp4" | "video/webm",
  linkedRecordingId?: string,
  config?: UploadClientConfig,
): Promise<StreamingUploadController> {
  const response = await fetch(apiUrl(config, "/api/upload-sessions"), {
    method: "POST",
    headers: apiHeaders(config, { "content-type": "application/json" }),
    body: JSON.stringify({
      title,
      contentType,
      streaming: true,
      ...(linkedRecordingId ? { linkedRecordingId } : {}),
    }),
  });
  if (!response.ok)
    throw await responseError(response, "Could not create streaming upload");
  const payload = (await response.json()) as {
    sessionId: string;
    recordingId: string;
    partSizeBytes: number;
  };
  let current: PendingUpload = {
    ...payload,
    blob: new Blob([], { type: contentType }),
    completionIdempotencyKey: crypto.randomUUID(),
    uploadedParts: [],
    streaming: true,
  };
  await write(current);

  // MediaRecorder events may arrive while a previous checksum or PUT is still
  // running. One chain preserves byte order and bounds concurrent memory.
  let work: Promise<unknown> = Promise.resolve();

  const uploadReadyPrefix = async (): Promise<void> => {
    let uploadedBytes = current.uploadedParts.reduce(
      (total, part) => total + part.contentLength,
      0,
    );
    // Strictly greater leaves at least one byte (or one whole part) for the
    // final request. S3/R2 cannot change an already-uploaded non-final part into
    // a final part after stop.
    while (current.blob.size - uploadedBytes > current.partSizeBytes) {
      const partNumber = current.uploadedParts.length + 1;
      const body = current.blob.slice(
        uploadedBytes,
        uploadedBytes + current.partSizeBytes,
      );
      const checksum = await checksumSha256(body);
      const sign = await fetch(
        apiUrl(
          config,
          `/api/upload-sessions/${current.sessionId}/parts/${partNumber}`,
        ),
        {
          method: "POST",
          headers: apiHeaders(config, { "content-type": "application/json" }),
          body: JSON.stringify({
            contentLength: body.size,
            checksumSha256: checksum,
            isFinalPart: false,
          }),
        },
      );
      if (!sign.ok)
        throw await responseError(sign, "Could not sign streaming upload part");
      const signed = (await sign.json()) as {
        url: string;
        method: "PUT";
        requiredHeaders: Record<string, string>;
      };
      const stored = await fetch(signed.url, {
        method: signed.method,
        headers: signed.requiredHeaders,
        body,
      });
      const etag = stored.headers.get("etag");
      if (!stored.ok)
        throw new Error(
          `Storage rejected streaming upload part (HTTP ${stored.status})`,
        );
      if (!etag)
        throw new Error(
          "Upload succeeded but storage CORS did not expose ETag",
        );
      current = {
        ...current,
        uploadedParts: [
          ...current.uploadedParts,
          {
            partNumber,
            etag,
            checksumSha256: checksum,
            contentLength: body.size,
            isFinalPart: false,
          },
        ],
      };
      uploadedBytes += body.size;
      await write(current);
    }
  };

  return {
    recordingId: current.recordingId,
    sessionId: current.sessionId,
    append(chunk) {
      const operation = work.then(async () => {
        if (!chunk.size)
          return {
            recordedBytes: current.blob.size,
            uploadedBytes: pendingUploadProgress(current).completedBytes,
          };
        current = {
          ...current,
          blob: new Blob([current.blob, chunk], {
            type: current.blob.type || contentType,
          }),
        };
        // Durability precedes network I/O: a failed PUT still leaves a complete
        // local recording that the recovery panel can resume.
        await write(current);
        await uploadReadyPrefix();
        return {
          recordedBytes: current.blob.size,
          uploadedBytes: pendingUploadProgress(current).completedBytes,
        };
      });
      work = operation.catch(() => undefined);
      return operation;
    },
    async finish(onProgress) {
      await work;
      if (!current.blob.size)
        throw new Error("Recording produced no media data");
      const result = await resumeUploadAttempt(current, onProgress, {
        ...config,
        concurrency: 1,
      });
      return result;
    },
    snapshot: () => current,
  };
}

async function restartPendingUpload(
  upload: PendingUpload,
  config?: UploadClientConfig,
): Promise<PendingUpload> {
  const response = await fetch(
    apiUrl(config, `/api/upload-sessions/${upload.sessionId}/restart`),
    {
      method: "POST",
      headers: apiHeaders(config, {}),
    },
  );
  if (!response.ok)
    throw await responseError(response, "Could not restart upload session");
  const payload = (await response.json()) as {
    sessionId: string;
    recordingId: string;
    partSizeBytes: number;
  };
  const restarted: PendingUpload = {
    ...upload,
    ...payload,
    completionIdempotencyKey: crypto.randomUUID(),
    uploadedParts: [],
  };
  await replace(upload.sessionId, restarted);
  return restarted;
}

async function resumeUploadAttempt(
  initialUpload: PendingUpload,
  onProgress?: (completedBytes: number, totalBytes: number) => void,
  config?: UploadClientConfig,
  allowProviderRestart = true,
) {
  let upload = initialUpload;
  // Older prototype receipts had no checksums and cannot satisfy the hardened contract.
  const completed = new Map(
    upload.uploadedParts
      .filter((part) => part.checksumSha256 && part.contentLength)
      .map((part) => [part.partNumber, part]),
  );
  if (!upload.completionIdempotencyKey) {
    upload = { ...upload, completionIdempotencyKey: crypto.randomUUID() };
  }
  upload = { ...upload, uploadedParts: [...completed.values()] };
  const totalParts = Math.ceil(upload.blob.size / upload.partSizeBytes);
  onProgress?.(pendingUploadProgress(upload).completedBytes, upload.blob.size);

  const outstanding: number[] = [];
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1)
    if (!completed.has(partNumber)) outstanding.push(partNumber);

  // Persisted receipts are what make an interrupted upload resumable, so writes
  // are chained rather than raced: each one records every part finished so far,
  // and the last to land is the most complete.
  let persisted: Promise<unknown> = Promise.resolve();
  const persist = () => {
    upload = { ...upload, uploadedParts: sortedParts(completed) };
    const snapshot = upload;
    persisted = persisted.then(() => write(snapshot));
    return persisted;
  };

  /** Set when a part 404s: the whole session is restarted, so stop feeding it. */
  let providerRestartNeeded = false;

  const uploadPart = async (partNumber: number) => {
    const start = (partNumber - 1) * upload.partSizeBytes;
    const body = upload.blob.slice(
      start,
      Math.min(start + upload.partSizeBytes, upload.blob.size),
    );
    const checksum = await checksumSha256(body);
    const isFinalPart = partNumber === totalParts;
    const sign = await fetch(
      apiUrl(
        config,
        `/api/upload-sessions/${upload.sessionId}/parts/${partNumber}`,
      ),
      {
        method: "POST",
        headers: apiHeaders(config, { "content-type": "application/json" }),
        body: JSON.stringify({
          contentLength: body.size,
          checksumSha256: checksum,
          isFinalPart,
        }),
      },
    );
    if (!sign.ok) throw await responseError(sign, "Could not sign upload part");
    const signed = (await sign.json()) as {
      url: string;
      method: "PUT";
      requiredHeaders: Record<string, string>;
    };
    const result = await fetch(signed.url, {
      method: signed.method,
      headers: signed.requiredHeaders,
      body,
    });
    const etag = result.headers.get("etag");
    if (result.status === 404 && allowProviderRestart) {
      providerRestartNeeded = true;
      return;
    }
    if (!result.ok) {
      throw new Error(`Storage rejected upload part (HTTP ${result.status})`);
    }
    if (!etag) {
      throw new Error("Upload succeeded but storage CORS did not expose ETag");
    }
    completed.set(partNumber, {
      partNumber,
      etag,
      checksumSha256: checksum,
      contentLength: body.size,
      isFinalPart,
    });
    await persist();
    onProgress?.(
      pendingUploadProgress(upload).completedBytes,
      upload.blob.size,
    );
  };

  // Parts are independent objects in the same multipart upload, so the only
  // reason to send them one at a time was that the loop did. A handful in
  // flight keeps a home connection saturated; more than that mostly competes
  // with itself and with the recorder still holding the tab.
  let next = 0;
  const workers = Array.from(
    { length: Math.min(uploadConcurrency(config), outstanding.length) },
    async () => {
      while (next < outstanding.length && !providerRestartNeeded)
        await uploadPart(outstanding[next++]!);
    },
  );
  const settled = await Promise.allSettled(workers);
  // Every worker is awaited before rethrowing, so no request is still running
  // against a session that is about to be replaced or abandoned.
  await persisted.catch(() => undefined);
  const failure = settled.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;

  if (providerRestartNeeded) {
    const restarted = await restartPendingUpload(upload, config);
    onProgress?.(0, restarted.blob.size);
    return resumeUploadAttempt(restarted, onProgress, config, false);
  }

  const finished = await fetch(
    apiUrl(config, `/api/upload-sessions/${upload.sessionId}/complete`),
    {
      method: "POST",
      headers: apiHeaders(config, {
        "content-type": "application/json",
        "idempotency-key": upload.completionIdempotencyKey,
      }),
      body: JSON.stringify({
        parts: sortedParts(completed).map(
          ({ partNumber, etag, checksumSha256 }) => ({
            partNumber,
            etag,
            checksumSha256,
          }),
        ),
      }),
    },
  );
  if (!finished.ok)
    throw await responseError(finished, "Could not complete upload");
  await remove(upload.sessionId);
  return finished.json() as Promise<{
    recordingId: string;
    status: "PROCESSING";
    sizeBytes: number;
  }>;
}

export async function resumeUpload(
  initialUpload: PendingUpload,
  onProgress?: (completedBytes: number, totalBytes: number) => void,
  config?: UploadClientConfig,
) {
  return resumeUploadAttempt(
    initialUpload,
    onProgress,
    initialUpload.streaming ? { ...config, concurrency: 1 } : config,
  );
}

export async function abortResumableUpload(
  upload: PendingUpload,
  config?: UploadClientConfig,
): Promise<void> {
  const response = await fetch(
    apiUrl(config, `/api/upload-sessions/${upload.sessionId}`),
    { method: "DELETE", headers: apiHeaders(config, {}) },
  );
  if (!response.ok && response.status !== 404) {
    throw await responseError(response, "Could not abort upload");
  }
  await remove(upload.sessionId);
}
