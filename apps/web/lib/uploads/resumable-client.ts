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
};

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
};

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
      contentType: blob.type === "video/mp4" ? "video/mp4" : "video/webm",
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

  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    if (completed.has(partNumber)) continue;
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
      const restarted = await restartPendingUpload(upload, config);
      onProgress?.(0, restarted.blob.size);
      return resumeUploadAttempt(restarted, onProgress, config, false);
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
    upload = { ...upload, uploadedParts: [...completed.values()] };
    await write(upload);
    onProgress?.(
      pendingUploadProgress(upload).completedBytes,
      upload.blob.size,
    );
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
        parts: [...completed.values()].map(
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
  return resumeUploadAttempt(initialUpload, onProgress, config);
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
