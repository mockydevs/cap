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
): Promise<PendingUpload> {
  const response = await fetch("/api/upload-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

export async function resumeUpload(
  initialUpload: PendingUpload,
  onProgress?: (completed: number, total: number) => void,
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
  const totalParts = Math.ceil(upload.blob.size / upload.partSizeBytes);

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
      `/api/upload-sessions/${upload.sessionId}/parts/${partNumber}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    if (!result.ok || !etag) {
      throw new Error(
        "Part upload failed; S3 CORS must expose ETag and accept checksum headers",
      );
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
    onProgress?.(completed.size, totalParts);
  }

  const finished = await fetch(
    `/api/upload-sessions/${upload.sessionId}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": upload.completionIdempotencyKey,
      },
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

export async function abortResumableUpload(
  upload: PendingUpload,
): Promise<void> {
  const response = await fetch(`/api/upload-sessions/${upload.sessionId}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw await responseError(response, "Could not abort upload");
  }
  await remove(upload.sessionId);
}
