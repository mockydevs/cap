"use client";

const DATABASE_NAME = "cap-upload-queue";
const STORE_NAME = "uploads";
const CHUNK_STORE_NAME = "upload-chunks";
const DATABASE_VERSION = 2;

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
  /** Streaming uploads persist immutable recorder chunks instead of rewriting one growing Blob. */
  chunkCount?: number;
  recordedBytes?: number;
  blobType?: string;
};

const DEFAULT_UPLOAD_CONCURRENCY = 4;
const LIVE_UPLOAD_CONCURRENCY = 3;

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
  const totalBytes = upload.recordedBytes ?? upload.blob.size;
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
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      if (!request.result.objectStoreNames.contains(CHUNK_STORE_NAME)) {
        const chunks = request.result.createObjectStore(CHUNK_STORE_NAME, {
          keyPath: ["sessionId", "index"],
        });
        chunks.createIndex("sessionId", "sessionId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function write(upload: PendingUpload) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(
      upload.chunkCount === undefined
        ? upload
        : {
            ...upload,
            blob: new Blob([], {
              type: upload.blobType || upload.blob.type,
            }),
          },
    );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function appendStreamingChunk(
  upload: PendingUpload,
  index: number,
  chunk: Blob,
) {
  const bytes = await chunk.arrayBuffer();
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      [STORE_NAME, CHUNK_STORE_NAME],
      "readwrite",
    );
    transaction.objectStore(CHUNK_STORE_NAME).put({
      sessionId: upload.sessionId,
      index,
      bytes,
    });
    transaction.objectStore(STORE_NAME).put({
      ...upload,
      blob: new Blob([], { type: upload.blobType || chunk.type }),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function deleteStoredChunks(
  transaction: IDBTransaction,
  sessionId: string,
): Promise<void> {
  const store = transaction.objectStore(CHUNK_STORE_NAME);
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = store.index("sessionId").getAllKeys(sessionId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const key of keys) store.delete(key);
}

async function remove(sessionId: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      [STORE_NAME, CHUNK_STORE_NAME],
      "readwrite",
    );
    transaction.objectStore(STORE_NAME).delete(sessionId);
    void deleteStoredChunks(transaction, sessionId).catch(reject);
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
    const transaction = database.transaction(
      [STORE_NAME, CHUNK_STORE_NAME],
      "readwrite",
    );
    const store = transaction.objectStore(STORE_NAME);
    store.put({
      ...upload,
      chunkCount: undefined,
      recordedBytes: upload.blob.size,
      blobType: upload.blob.type,
    });
    store.delete(previousSessionId);
    void deleteStoredChunks(transaction, previousSessionId).catch(reject);
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
  const hydrated = await Promise.all(
    uploads.map((upload) => hydrateStoredUpload(database, upload)),
  );
  database.close();
  return hydrated;
}

async function hydrateStoredUpload(
  database: IDBDatabase,
  upload: PendingUpload,
): Promise<PendingUpload> {
  if (upload.chunkCount === undefined) return upload;
  const chunks = await new Promise<
    { sessionId: string; index: number; bytes: ArrayBuffer }[]
  >((resolve, reject) => {
    const request = database
      .transaction(CHUNK_STORE_NAME)
      .objectStore(CHUNK_STORE_NAME)
      .index("sessionId")
      .getAll(IDBKeyRange.only(upload.sessionId));
    request.onsuccess = () =>
      resolve(
        (
          request.result as {
            sessionId: string;
            index: number;
            bytes: ArrayBuffer;
          }[]
        )
          .filter((chunk) => chunk.sessionId === upload.sessionId)
          .sort((left, right) => left.index - right.index),
      );
    request.onerror = () => reject(request.error);
  });
  return {
    ...upload,
    blob: new Blob(
      chunks.slice(0, upload.chunkCount).map((chunk) => chunk.bytes),
      { type: upload.blobType || upload.blob.type },
    ),
  };
}

async function readPendingUpload(
  sessionId: string,
): Promise<PendingUpload | undefined> {
  const database = await openDatabase();
  const upload = await new Promise<PendingUpload | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(STORE_NAME)
        .objectStore(STORE_NAME)
        .get(sessionId);
      request.onsuccess = () =>
        resolve(request.result as PendingUpload | undefined);
      request.onerror = () => reject(request.error);
    },
  );
  const hydrated = upload
    ? await hydrateStoredUpload(database, upload)
    : undefined;
  database.close();
  return hydrated;
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

async function acknowledgeStoredPart(
  upload: PendingUpload,
  part: UploadedPart,
  config?: UploadClientConfig,
): Promise<void> {
  const response = await fetch(
    apiUrl(
      config,
      `/api/upload-sessions/${upload.sessionId}/parts/${part.partNumber}`,
    ),
    {
      method: "PATCH",
      headers: apiHeaders(config, { "content-type": "application/json" }),
      body: JSON.stringify({
        etag: part.etag,
        recordedBytes: upload.recordedBytes ?? upload.blob.size,
      }),
    },
  );
  if (!response.ok)
    throw await responseError(response, "Could not acknowledge upload part");
}

async function reportStreamingProgress(
  upload: PendingUpload,
  input: { error?: string | null; sealed?: boolean } = {},
  config?: UploadClientConfig,
): Promise<void> {
  const response = await fetch(
    apiUrl(config, `/api/upload-sessions/${upload.sessionId}`),
    {
      method: "PATCH",
      headers: apiHeaders(config, { "content-type": "application/json" }),
      body: JSON.stringify({
        recordedBytes: upload.recordedBytes ?? upload.blob.size,
        ...input,
      }),
    },
  );
  if (!response.ok)
    throw await responseError(response, "Could not report upload progress");
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
 * durably appended to IndexedDB first. Complete provider-sized parts are sent
 * immediately with bounded parallel PUTs; only the sub-part tail remains when
 * capture stops.
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
    chunkCount: 0,
    recordedBytes: 0,
    blobType: contentType,
  };
  await write(current);
  let tailChunks: Blob[] = [];
  let tailBytes = 0;
  let nextPartNumber = 1;
  let appendWork: Promise<unknown> = Promise.resolve();
  let signWork: Promise<unknown> = Promise.resolve();
  let signError: unknown;
  let commitWork: Promise<unknown> = Promise.resolve();
  let activePuts = 0;
  const putWaiters: (() => void)[] = [];
  const partTasks: Promise<void>[] = [];
  let streamError: unknown;
  let lastProgressReportAt = 0;
  let progressReportInFlight = false;

  const acquirePutSlot = async () => {
    if (activePuts < LIVE_UPLOAD_CONCURRENCY) {
      activePuts += 1;
      return;
    }
    await new Promise<void>((resolve) => putWaiters.push(resolve));
    activePuts += 1;
  };
  const releasePutSlot = () => {
    activePuts -= 1;
    putWaiters.shift()?.();
  };

  const reportProgressSoon = () => {
    if (progressReportInFlight || Date.now() - lastProgressReportAt < 5_000)
      return;
    lastProgressReportAt = Date.now();
    progressReportInFlight = true;
    void reportStreamingProgress(
      current,
      {
        error:
          streamError instanceof Error
            ? streamError.message
            : streamError
              ? "Upload paused"
              : null,
      },
      config,
    )
      .catch(() => undefined)
      .finally(() => {
        progressReportInFlight = false;
      });
  };

  const schedulePart = (body: Blob, isFinalPart: boolean) => {
    const partNumber = nextPartNumber;
    nextPartNumber += 1;
    const signed = signWork.then(async () => {
      if (signError) throw signError;
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
            isFinalPart,
          }),
        },
      );
      if (!sign.ok)
        throw await responseError(sign, "Could not sign streaming upload part");
      return {
        checksumSha256: checksum,
        signed: (await sign.json()) as {
          url: string;
          method: "PUT";
          requiredHeaders: Record<string, string>;
        },
      };
    });
    // Signing remains ordered because the service persists contiguous intents;
    // storage PUTs begin independently as soon as each signature is available.
    signWork = signed.then(
      () => undefined,
      (error) => {
        signError ??= error;
      },
    );
    const task = signed
      .then(async ({ checksumSha256, signed: request }) => {
        await acquirePutSlot();
        try {
          const stored = await fetch(request.url, {
            method: request.method,
            headers: request.requiredHeaders,
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
          const receipt: UploadedPart = {
            partNumber,
            etag,
            checksumSha256,
            contentLength: body.size,
            isFinalPart,
          };
          await (commitWork = commitWork.then(async () => {
            current = {
              ...current,
              uploadedParts: [...current.uploadedParts, receipt].sort(
                (left, right) => left.partNumber - right.partNumber,
              ),
            };
            await write(current);
            await acknowledgeStoredPart(current, receipt, config).catch(
              () => undefined,
            );
          }));
        } finally {
          releasePutSlot();
        }
      })
      .catch((error) => {
        streamError ??= error;
        void reportStreamingProgress(
          current,
          {
            error: error instanceof Error ? error.message : "Upload paused",
          },
          config,
        ).catch(() => undefined);
        throw error;
      });
    // A capture may continue safely after the network task rejects; finish()
    // observes the same task and surfaces the failure without an unhandled rejection.
    void task.catch(() => undefined);
    partTasks.push(task);
  };

  return {
    recordingId: current.recordingId,
    sessionId: current.sessionId,
    append(chunk) {
      const operation = appendWork.then(async () => {
        if (!chunk.size)
          return {
            recordedBytes: current.recordedBytes ?? 0,
            uploadedBytes: pendingUploadProgress(current).completedBytes,
          };
        tailChunks.push(chunk);
        tailBytes += chunk.size;
        current = {
          ...current,
          chunkCount: (current.chunkCount ?? 0) + 1,
          recordedBytes: (current.recordedBytes ?? 0) + chunk.size,
        };
        await appendStreamingChunk(current, current.chunkCount! - 1, chunk);
        while (tailBytes >= current.partSizeBytes) {
          const tail = new Blob(tailChunks, { type: contentType });
          schedulePart(tail.slice(0, current.partSizeBytes), false);
          const remainder = tail.slice(current.partSizeBytes);
          tailChunks = remainder.size ? [remainder] : [];
          tailBytes = remainder.size;
        }
        reportProgressSoon();
        return {
          recordedBytes: current.recordedBytes ?? 0,
          uploadedBytes: pendingUploadProgress(current).completedBytes,
        };
      });
      appendWork = operation.catch(() => undefined);
      return operation;
    },
    async finish(onProgress) {
      await appendWork;
      if (!(current.recordedBytes ?? 0))
        throw new Error("Recording produced no media data");
      if (tailBytes) {
        schedulePart(new Blob(tailChunks, { type: contentType }), true);
        tailChunks = [];
        tailBytes = 0;
      }
      const settled = await Promise.allSettled(partTasks);
      await commitWork;
      current = (await readPendingUpload(current.sessionId)) ?? current;
      const failed = settled.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (streamError || failed) throw streamError ?? failed?.reason;
      const result = await resumeUploadAttempt(current, onProgress, {
        ...config,
        concurrency: LIVE_UPLOAD_CONCURRENCY,
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

  const prepareUploadPart = async (partNumber: number) => {
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
    return {
      partNumber,
      body,
      checksum,
      isFinalPart,
      signed: (await sign.json()) as {
        url: string;
        method: "PUT";
        requiredHeaders: Record<string, string>;
      },
    };
  };

  const uploadPreparedPart = async (
    prepared: Awaited<ReturnType<typeof prepareUploadPart>>,
  ) => {
    const { partNumber, body, checksum, isFinalPart, signed } = prepared;
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
    const receipt: UploadedPart = {
      partNumber,
      etag,
      checksumSha256: checksum,
      contentLength: body.size,
      isFinalPart,
    };
    completed.set(partNumber, receipt);
    await persist();
    if (upload.streaming)
      await acknowledgeStoredPart(upload, receipt, config).catch(
        () => undefined,
      );
    onProgress?.(
      pendingUploadProgress(upload).completedBytes,
      upload.blob.size,
    );
  };

  // Signatures are requested in contiguous order because the service persists
  // ordered intents. Each small batch is then PUT in parallel to saturate the
  // connection without creating thousands of short-lived presigned URLs.
  const concurrency = uploadConcurrency(config);
  let failure: PromiseRejectedResult | undefined;
  for (
    let offset = 0;
    offset < outstanding.length && !providerRestartNeeded && !failure;
    offset += concurrency
  ) {
    const batchNumbers = outstanding.slice(offset, offset + concurrency);
    const prepared = [];
    for (const partNumber of batchNumbers)
      prepared.push(await prepareUploadPart(partNumber));
    const settled = await Promise.allSettled(prepared.map(uploadPreparedPart));
    failure = settled.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
  }
  await persisted.catch(() => undefined);
  if (failure) throw failure.reason;

  if (providerRestartNeeded) {
    const restarted = await restartPendingUpload(upload, config);
    onProgress?.(0, restarted.blob.size);
    return resumeUploadAttempt(restarted, onProgress, config, false);
  }

  // Recovery may resume an exact-multiple recording whose final full part was
  // uploaded while capture was live. Seal it only after every missing intent
  // and storage part has been restored.
  if (upload.streaming)
    await reportStreamingProgress(
      upload,
      { error: null, sealed: true },
      config,
    );

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
    initialUpload.streaming
      ? { ...config, concurrency: LIVE_UPLOAD_CONCURRENCY }
      : config,
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
