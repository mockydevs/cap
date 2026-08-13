import type {
  CompletedUploadPart,
  RecordingId,
  S3EntityTag,
  Sha256Base64,
  SourceMediaType,
  UploadSessionId,
  VerifiedCompletedUpload,
  WorkspaceId,
} from "@cap/domain";
import type { MediaObjectKey } from "./media-object-key";

declare const multipartUploadIdBrand: unique symbol;
export type MultipartUploadId = string & {
  readonly [multipartUploadIdBrand]: true;
};

export function multipartUploadId(value: string): MultipartUploadId {
  if (
    value.length < 1 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new StorageContractError(
      "INVALID_UPLOAD_ID",
      "Invalid multipart upload identifier",
    );
  }
  return value as MultipartUploadId;
}

export class StorageContractError extends Error {
  readonly code:
    | "INVALID_CONFIG"
    | "INVALID_UPLOAD_ID"
    | "INVALID_EXPIRY"
    | "INVALID_PART"
    | "INVALID_S3_RESPONSE";

  constructor(code: StorageContractError["code"], message: string) {
    super(message);
    this.name = "StorageContractError";
    this.code = code;
  }
}

export interface CreateSourceMultipartUpload {
  readonly objectKey: MediaObjectKey;
  readonly workspaceId: WorkspaceId;
  readonly recordingId: RecordingId;
  readonly uploadSessionId: UploadSessionId;
  readonly mediaType: SourceMediaType;
}

export interface CreatedSourceMultipartUpload {
  readonly uploadId: MultipartUploadId;
  readonly objectKey: MediaObjectKey;
}

export interface PresignUploadPart {
  readonly objectKey: MediaObjectKey;
  readonly uploadId: MultipartUploadId;
  readonly partNumber: number;
  readonly contentLength: number;
  readonly checksumSha256: Sha256Base64;
  readonly expiresInSeconds: number;
}

export interface PresignedUploadPart {
  readonly url: string;
  readonly method: "PUT";
  readonly expiresAt: Date;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface MultipartUploadReference {
  readonly objectKey: MediaObjectKey;
  readonly uploadId: MultipartUploadId;
}

export interface CompleteSourceMultipartUpload extends MultipartUploadReference {
  /** This must have been constructed from the storage provider's ListParts result. */
  readonly verifiedUpload: VerifiedCompletedUpload;
}

export interface CompletedSourceMultipartUpload {
  readonly objectKey: MediaObjectKey;
  readonly etag: S3EntityTag;
  readonly versionId?: string;
}

export interface StoredSourceObject {
  readonly objectKey: MediaObjectKey;
  readonly contentLength: number;
  readonly contentType: string;
  readonly etag: S3EntityTag;
  readonly versionId?: string;
  /**
   * Present only where the bucket is configured with a KMS key. Stores without
   * KMS (Cloudflare R2, MinIO, Backblaze B2) encrypt at rest under their own
   * provider-managed keys and report no per-object key.
   */
  readonly encryption?: "aws:kms";
  readonly kmsKeyId?: string;
}

/**
 * AWS details terminate at this port. The application service owns authorization,
 * session persistence, state transitions, idempotency, quota reservation, and
 * comparison of the browser's completion manifest to listUploadedParts().
 */
export interface MultipartObjectStorage {
  createSourceMultipartUpload(
    input: CreateSourceMultipartUpload,
  ): Promise<CreatedSourceMultipartUpload>;
  presignUploadPart(input: PresignUploadPart): Promise<PresignedUploadPart>;
  listUploadedParts(
    input: MultipartUploadReference,
  ): Promise<readonly CompletedUploadPart[]>;
  completeSourceMultipartUpload(
    input: CompleteSourceMultipartUpload,
  ): Promise<CompletedSourceMultipartUpload>;
  abortMultipartUpload(input: MultipartUploadReference): Promise<void>;
  findSourceObject(
    objectKey: MediaObjectKey,
  ): Promise<StoredSourceObject | undefined>;
  headSourceObject(objectKey: MediaObjectKey): Promise<StoredSourceObject>;
}

export interface PresignedPlayback {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PlaybackObjectStorage {
  presignPlayback(input: {
    readonly objectKey: MediaObjectKey;
    readonly expiresInSeconds: number;
  }): Promise<PresignedPlayback>;
}

/** Retention hard-purge deletes every object under a recording's namespace. */
export interface PurgeableObjectStorage {
  deleteRecordingObjects(input: {
    readonly workspaceId: WorkspaceId;
    readonly recordingId: RecordingId;
  }): Promise<void>;
}

/**
 * Small, whole-object text reads/writes (generated captions, exports of a
 * few KB) that don't need multipart upload machinery. Still SSE-KMS
 * encrypted like every other object in the bucket.
 */
export interface SmallObjectStorage {
  putTextObject(input: {
    readonly objectKey: MediaObjectKey;
    readonly content: string;
    readonly contentType: string;
  }): Promise<void>;
  getTextObject(objectKey: MediaObjectKey): Promise<string | undefined>;
}

export function assertPlaybackExpirySeconds(value: number): void {
  if (!Number.isInteger(value) || value < 30 || value > 900) {
    throw new StorageContractError(
      "INVALID_EXPIRY",
      "Playback presigned URLs must expire in 30-900 seconds",
    );
  }
}

export function assertPresignExpirySeconds(value: number): void {
  if (!Number.isInteger(value) || value < 60 || value > 900) {
    throw new StorageContractError(
      "INVALID_EXPIRY",
      "Upload-part presigned URLs must expire in 60-900 seconds",
    );
  }
}
