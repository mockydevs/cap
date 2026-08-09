const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const sha256Base64Pattern = /^[A-Za-z0-9+/]{43}=$/;

declare const identifierBrand: unique symbol;

type Identifier<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type WorkspaceId = Identifier<"WorkspaceId">;
export type RecordingId = Identifier<"RecordingId">;
export type UploadSessionId = Identifier<"UploadSessionId">;

export const S3_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const S3_MAX_MULTIPART_PART_BYTES = 5 * 1024 * 1024 * 1024;
export const S3_MAX_MULTIPART_PARTS = 10_000;
export const S3_MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

export class UploadContractError extends Error {
  readonly code:
    | "INVALID_IDENTIFIER"
    | "INVALID_MEDIA_TYPE"
    | "INVALID_UPLOAD_PLAN"
    | "INVALID_PART"
    | "INVALID_CHECKSUM"
    | "INVALID_ETAG"
    | "INVALID_TRANSITION";

  constructor(code: UploadContractError["code"], message: string) {
    super(message);
    this.name = "UploadContractError";
    this.code = code;
  }
}

function parseIdentifier<Name extends string>(value: string, name: Name): Identifier<Name> {
  if (!identifierPattern.test(value)) {
    throw new UploadContractError(
      "INVALID_IDENTIFIER",
      `${name} must be 1-128 URL-safe identifier characters`,
    );
  }
  return value as Identifier<Name>;
}

export function workspaceId(value: string): WorkspaceId {
  return parseIdentifier(value, "WorkspaceId");
}

export function recordingId(value: string): RecordingId {
  return parseIdentifier(value, "RecordingId");
}

export function uploadSessionId(value: string): UploadSessionId {
  return parseIdentifier(value, "UploadSessionId");
}

export type SourceMediaType =
  | "video/webm"
  | "video/mp4"
  | "video/quicktime"
  | "video/x-matroska";

const sourceMediaTypes = new Set<SourceMediaType>([
  "video/webm",
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
]);

export function sourceMediaType(value: string): SourceMediaType {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || !sourceMediaTypes.has(normalized as SourceMediaType)) {
    throw new UploadContractError("INVALID_MEDIA_TYPE", "Unsupported source media type");
  }
  return normalized as SourceMediaType;
}

export interface UploadPlan {
  readonly partSizeBytes: number;
  readonly maxUploadBytes: number;
  readonly maxPartCount: number;
}

export interface UploadPolicy {
  readonly partSizeBytes: number;
  readonly maxUploadBytes: number;
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UploadContractError("INVALID_UPLOAD_PLAN", `${label} must be a positive safe integer`);
  }
}

/**
 * Creates a server-controlled plan. A client may request a lower quota, but it
 * must never be able to increase either value returned by the server policy.
 */
export function createUploadPlan(policy: UploadPolicy): UploadPlan {
  assertSafePositiveInteger(policy.partSizeBytes, "partSizeBytes");
  assertSafePositiveInteger(policy.maxUploadBytes, "maxUploadBytes");

  if (
    policy.partSizeBytes < S3_MIN_MULTIPART_PART_BYTES ||
    policy.partSizeBytes > S3_MAX_MULTIPART_PART_BYTES
  ) {
    throw new UploadContractError(
      "INVALID_UPLOAD_PLAN",
      "partSizeBytes is outside the S3 multipart range",
    );
  }
  if (policy.maxUploadBytes > S3_MAX_OBJECT_BYTES) {
    throw new UploadContractError("INVALID_UPLOAD_PLAN", "maxUploadBytes exceeds the S3 object limit");
  }

  const maxPartCount = Math.ceil(policy.maxUploadBytes / policy.partSizeBytes);
  if (maxPartCount > S3_MAX_MULTIPART_PARTS) {
    throw new UploadContractError(
      "INVALID_UPLOAD_PLAN",
      "The upload plan would require more than 10,000 parts",
    );
  }

  return Object.freeze({
    partSizeBytes: policy.partSizeBytes,
    maxUploadBytes: policy.maxUploadBytes,
    maxPartCount,
  });
}

export type Sha256Base64 = string & { readonly __sha256Base64: true };

export function sha256Base64(value: string): Sha256Base64 {
  if (!sha256Base64Pattern.test(value)) {
    throw new UploadContractError(
      "INVALID_CHECKSUM",
      "checksumSha256 must be a base64-encoded 32-byte SHA-256 digest",
    );
  }
  return value as Sha256Base64;
}

export type S3EntityTag = string & { readonly __s3EntityTag: true };

export function s3EntityTag(value: string): S3EntityTag {
  if (value.length < 3 || value.length > 130 || /[\r\n]/.test(value) || !/^"[^"]+"$/.test(value)) {
    throw new UploadContractError("INVALID_ETAG", "ETag must be a quoted, bounded opaque value");
  }
  return value as S3EntityTag;
}

export interface UploadPartIntent {
  readonly partNumber: number;
  readonly contentLength: number;
  readonly checksumSha256: Sha256Base64;
  readonly isFinalPart: boolean;
}

/**
 * Validates the immutable values that will be bound into a presigned UploadPart
 * request. The application service must additionally verify session ownership,
 * state, expiry, and that no final part has already been declared.
 */
export function validateUploadPartIntent(
  plan: UploadPlan,
  intent: UploadPartIntent,
): UploadPartIntent {
  if (
    !Number.isInteger(intent.partNumber) ||
    intent.partNumber < 1 ||
    intent.partNumber > plan.maxPartCount
  ) {
    throw new UploadContractError("INVALID_PART", "partNumber is outside the upload plan");
  }
  if (!Number.isSafeInteger(intent.contentLength) || intent.contentLength <= 0) {
    throw new UploadContractError("INVALID_PART", "contentLength must be a positive safe integer");
  }

  if (intent.isFinalPart) {
    if (intent.contentLength > plan.partSizeBytes) {
      throw new UploadContractError("INVALID_PART", "The final part exceeds the planned part size");
    }
  } else if (intent.contentLength !== plan.partSizeBytes) {
    throw new UploadContractError(
      "INVALID_PART",
      "Every non-final part must exactly match the planned part size",
    );
  }

  const totalBytesIfFinal = (intent.partNumber - 1) * plan.partSizeBytes + intent.contentLength;
  if (totalBytesIfFinal > plan.maxUploadBytes) {
    throw new UploadContractError("INVALID_PART", "The part would exceed the upload quota");
  }

  sha256Base64(intent.checksumSha256);
  return Object.freeze({ ...intent });
}

export interface CompletedUploadPart {
  readonly partNumber: number;
  readonly contentLength: number;
  readonly checksumSha256: Sha256Base64;
  readonly etag: S3EntityTag;
}

export interface VerifiedCompletedUpload {
  readonly parts: readonly CompletedUploadPart[];
  readonly totalBytes: number;
}

/**
 * Must be run on parts returned by S3 ListParts, not solely on the browser's
 * completion payload. This proves the final object is contiguous and within the
 * server-issued quota before CompleteMultipartUpload is called.
 */
export function verifyCompletedUpload(
  plan: UploadPlan,
  parts: readonly CompletedUploadPart[],
): VerifiedCompletedUpload {
  if (parts.length === 0 || parts.length > plan.maxPartCount) {
    throw new UploadContractError("INVALID_PART", "The upload has an invalid number of parts");
  }

  let totalBytes = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      throw new UploadContractError("INVALID_PART", "The upload contains a missing part");
    }
    const expectedPartNumber = index + 1;
    if (part.partNumber !== expectedPartNumber) {
      throw new UploadContractError("INVALID_PART", "Parts must be unique and contiguous from 1");
    }
    const isFinalPart = index === parts.length - 1;
    validateUploadPartIntent(plan, {
      partNumber: part.partNumber,
      contentLength: part.contentLength,
      checksumSha256: part.checksumSha256,
      isFinalPart,
    });
    s3EntityTag(part.etag);
    totalBytes += part.contentLength;
  }

  if (totalBytes > plan.maxUploadBytes) {
    throw new UploadContractError("INVALID_PART", "The completed upload exceeds its quota");
  }

  return Object.freeze({ parts: Object.freeze([...parts]), totalBytes });
}

export type MultipartUploadStatus =
  | "PENDING"
  | "UPLOADING"
  | "COMPLETING"
  | "COMPLETED"
  | "ABORTED"
  | "EXPIRED";

const allowedTransitions: Readonly<Record<MultipartUploadStatus, readonly MultipartUploadStatus[]>> = {
  PENDING: ["UPLOADING", "ABORTED", "EXPIRED"],
  UPLOADING: ["COMPLETING", "ABORTED", "EXPIRED"],
  COMPLETING: ["UPLOADING", "COMPLETED", "ABORTED"],
  COMPLETED: [],
  ABORTED: [],
  EXPIRED: [],
};

export function assertMultipartUploadTransition(
  from: MultipartUploadStatus,
  to: MultipartUploadStatus,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new UploadContractError("INVALID_TRANSITION", `Cannot transition upload from ${from} to ${to}`);
  }
}

export interface InitiateSourceUploadRequest {
  readonly recordingId: string;
  readonly mediaType: string;
  readonly requestedMaxBytes?: number;
}

export interface InitiateSourceUploadResponse {
  readonly uploadSessionId: string;
  readonly partSizeBytes: number;
  readonly maxUploadBytes: number;
  readonly maxPartCount: number;
  readonly expiresAt: string;
}

export interface SignSourceUploadPartRequest {
  readonly partNumber: number;
  readonly contentLength: number;
  readonly checksumSha256: string;
  readonly isFinalPart: boolean;
}

export interface SignSourceUploadPartResponse {
  readonly url: string;
  readonly method: "PUT";
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface CompleteSourceUploadRequest {
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly checksumSha256: string;
  }[];
}

export interface CompleteSourceUploadResponse {
  readonly recordingId: string;
  readonly status: "UPLOADED";
  readonly sizeBytes: number;
}
