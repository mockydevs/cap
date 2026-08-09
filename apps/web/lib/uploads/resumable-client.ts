"use client";

const DATABASE_NAME = "cap-upload-queue";
const STORE_NAME = "uploads";

export type PendingUpload = { sessionId: string; recordingId: string; partSizeBytes: number; blob: Blob; uploadedParts: Array<{ partNumber: number; etag: string }> };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function write(upload: PendingUpload) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => { const tx = database.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).put(upload); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  database.close();
}

async function remove(sessionId: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => { const tx = database.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).delete(sessionId); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  database.close();
}

export async function listPendingUploads(): Promise<PendingUpload[]> {
  const database = await openDatabase();
  const uploads = await new Promise<PendingUpload[]>((resolve, reject) => { const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result as PendingUpload[]); request.onerror = () => reject(request.error); });
  database.close(); return uploads;
}

/** Persists the source Blob before the first network request so browser reloads can resume it. */
export async function beginResumableUpload(title: string, blob: Blob): Promise<PendingUpload> {
  const response = await fetch("/api/upload-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, contentType: blob.type === "video/mp4" ? "video/mp4" : "video/webm", sizeBytes: blob.size }) });
  if (!response.ok) throw new Error("Could not create upload session");
  const payload = await response.json() as { sessionId: string; recordingId: string; partSizeBytes: number };
  const upload: PendingUpload = { ...payload, blob, uploadedParts: [] };
  await write(upload); return upload;
}

export async function resumeUpload(upload: PendingUpload, onProgress?: (completed: number, total: number) => void) {
  const completed = new Map(upload.uploadedParts.map((part) => [part.partNumber, part]));
  const totalParts = Math.ceil(upload.blob.size / upload.partSizeBytes);
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    if (completed.has(partNumber)) continue;
    const sign = await fetch(`/api/upload-sessions/${upload.sessionId}/parts/${partNumber}`);
    if (!sign.ok) throw new Error("Could not sign upload part");
    const { url } = await sign.json() as { url: string };
    const start = (partNumber - 1) * upload.partSizeBytes;
    const result = await fetch(url, { method: "PUT", body: upload.blob.slice(start, Math.min(start + upload.partSizeBytes, upload.blob.size)) });
    const etag = result.headers.get("etag");
    if (!result.ok || !etag) throw new Error("Part upload failed; ensure S3 CORS exposes ETag");
    completed.set(partNumber, { partNumber, etag }); upload = { ...upload, uploadedParts: [...completed.values()] }; await write(upload); onProgress?.(completed.size, totalParts);
  }
  const finished = await fetch(`/api/upload-sessions/${upload.sessionId}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [...completed.values()] }) });
  if (!finished.ok) throw new Error("Could not complete upload");
  await remove(upload.sessionId); return finished.json() as Promise<{ recordingId: string; status: string }>;
}
