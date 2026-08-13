import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3_MAX_MULTIPART_PART_BYTES,
  S3_MAX_MULTIPART_PARTS,
  s3EntityTag,
  sha256Base64,
  type RecordingId,
  type WorkspaceId,
} from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  buildRecordingObjectPrefix,
  type MediaObjectKey,
} from "./media-object-key";
import {
  assertPresignExpirySeconds,
  assertPlaybackExpirySeconds,
  multipartUploadId,
  StorageContractError,
  type CompleteSourceMultipartUpload,
  type CompletedSourceMultipartUpload,
  type CreatedSourceMultipartUpload,
  type CreateSourceMultipartUpload,
  type MultipartObjectStorage,
  type PlaybackObjectStorage,
  type MultipartUploadReference,
  type PresignedUploadPart,
  type PresignUploadPart,
  type PurgeableObjectStorage,
  type SmallObjectStorage,
  type StoredUploadPart,
  type StoredSourceObject,
} from "./multipart-storage";

export interface S3MultipartStorageOptions {
  readonly client: S3Client;
  readonly bucketName: string;
  /**
   * Omit for object stores without KMS (Cloudflare R2, MinIO, Backblaze B2).
   * When set, every object Cap writes is encrypted under this key and reads
   * assert that the stored object really carries it.
   */
  readonly kmsKeyArn?: string;
  /** Disable only for providers such as R2 that reject per-part SHA-256. */
  readonly multipartSha256Checksums?: boolean;
  readonly now?: () => Date;
}

function assertOptions(options: S3MultipartStorageOptions): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucketName) ||
    options.bucketName.includes("..")
  ) {
    throw new StorageContractError("INVALID_CONFIG", "Invalid S3 bucket name");
  }
  if (
    options.kmsKeyArn !== undefined &&
    !options.kmsKeyArn.startsWith("arn:aws:kms:")
  ) {
    throw new StorageContractError(
      "INVALID_CONFIG",
      "AWS_KMS_KEY_ARN must be a KMS ARN",
    );
  }
}

/**
 * Implementation for AWS S3 and any S3-compatible store. Endpoint and
 * addressing style belong to the client (see `createStorageClient`); this class
 * only decides what Cap asks the store to do.
 */
export class S3MultipartStorage
  implements
    MultipartObjectStorage,
    PlaybackObjectStorage,
    PurgeableObjectStorage,
    SmallObjectStorage
{
  readonly #client: S3Client;
  readonly #bucketName: string;
  readonly #kmsKeyArn: string | undefined;
  readonly #multipartSha256Checksums: boolean;
  readonly #now: () => Date;

  constructor(options: S3MultipartStorageOptions) {
    assertOptions(options);
    this.#client = options.client;
    this.#bucketName = options.bucketName;
    this.#kmsKeyArn = options.kmsKeyArn;
    this.#multipartSha256Checksums = options.multipartSha256Checksums ?? true;
    this.#now = options.now ?? (() => new Date());
  }

  /** SSE-KMS request fields, empty on stores that manage their own keys. */
  get #encryption() {
    return this.#kmsKeyArn
      ? {
          ServerSideEncryption: "aws:kms" as const,
          SSEKMSKeyId: this.#kmsKeyArn,
          BucketKeyEnabled: true,
        }
      : {};
  }

  async createSourceMultipartUpload(
    input: CreateSourceMultipartUpload,
  ): Promise<CreatedSourceMultipartUpload> {
    const objectKey = assertManagedMediaObjectKey(input.objectKey);
    const response = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
        ContentType: input.mediaType,
        ...(this.#multipartSha256Checksums
          ? { ChecksumAlgorithm: "SHA256" as const }
          : {}),
        ...this.#encryption,
        Metadata: {
          "workspace-id": input.workspaceId,
          "recording-id": input.recordingId,
          "upload-session-id": input.uploadSessionId,
        },
      }),
    );
    if (!response.UploadId) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "S3 did not return an upload ID",
      );
    }
    return { uploadId: multipartUploadId(response.UploadId), objectKey };
  }

  async presignUploadPart(
    input: PresignUploadPart,
  ): Promise<PresignedUploadPart> {
    assertManagedMediaObjectKey(input.objectKey);
    assertPresignExpirySeconds(input.expiresInSeconds);
    sha256Base64(input.checksumSha256);
    if (
      !Number.isInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > S3_MAX_MULTIPART_PARTS ||
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 1 ||
      input.contentLength > S3_MAX_MULTIPART_PART_BYTES
    ) {
      throw new StorageContractError(
        "INVALID_PART",
        "Invalid S3 multipart part number or size",
      );
    }

    const checksumHeader = "x-amz-checksum-sha256";
    const checksumFields = this.#multipartSha256Checksums
      ? { ChecksumSHA256: input.checksumSha256 }
      : {};
    const url = await getSignedUrl(
      this.#client,
      new UploadPartCommand({
        Bucket: this.#bucketName,
        Key: input.objectKey,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        ContentLength: input.contentLength,
        ...checksumFields,
      }),
      {
        expiresIn: input.expiresInSeconds,
        ...(this.#multipartSha256Checksums
          ? {
              // Bind the digest as a required request header instead of a mutable query value.
              unhoistableHeaders: new Set([checksumHeader]),
            }
          : {}),
      },
    );

    return {
      url,
      method: "PUT",
      expiresAt: new Date(
        this.#now().getTime() + input.expiresInSeconds * 1000,
      ),
      requiredHeaders: Object.freeze(
        this.#multipartSha256Checksums
          ? { [checksumHeader]: input.checksumSha256 }
          : {},
      ),
    };
  }

  async listUploadedParts(
    input: MultipartUploadReference,
  ): Promise<readonly StoredUploadPart[]> {
    assertManagedMediaObjectKey(input.objectKey);
    const parts: StoredUploadPart[] = [];
    let partNumberMarker: string | undefined;

    do {
      const response = await this.#client.send(
        new ListPartsCommand({
          Bucket: this.#bucketName,
          Key: input.objectKey,
          UploadId: input.uploadId,
          ...(partNumberMarker ? { PartNumberMarker: partNumberMarker } : {}),
        }),
      );
      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.Size === undefined ||
          !part.ETag ||
          (this.#multipartSha256Checksums && !part.ChecksumSHA256)
        ) {
          throw new StorageContractError(
            "INVALID_S3_RESPONSE",
            "S3 returned incomplete multipart part metadata",
          );
        }
        parts.push({
          partNumber: part.PartNumber,
          contentLength: part.Size,
          etag: s3EntityTag(part.ETag),
          ...(part.ChecksumSHA256
            ? { checksumSha256: sha256Base64(part.ChecksumSHA256) }
            : {}),
        });
      }
      partNumberMarker = response.IsTruncated
        ? response.NextPartNumberMarker
        : undefined;
      if (response.IsTruncated && !partNumberMarker) {
        throw new StorageContractError(
          "INVALID_S3_RESPONSE",
          "S3 returned a truncated part list without a continuation marker",
        );
      }
    } while (partNumberMarker);

    return Object.freeze(
      parts.sort((left, right) => left.partNumber - right.partNumber),
    );
  }

  async completeSourceMultipartUpload(
    input: CompleteSourceMultipartUpload,
  ): Promise<CompletedSourceMultipartUpload> {
    assertManagedMediaObjectKey(input.objectKey);
    const response = await this.#client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucketName,
        Key: input.objectKey,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.verifiedUpload.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
            ...(this.#multipartSha256Checksums
              ? { ChecksumSHA256: part.checksumSha256 }
              : {}),
          })),
        },
      }),
    );
    if (!response.ETag) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "S3 completion returned no ETag",
      );
    }
    return {
      objectKey: input.objectKey,
      etag: s3EntityTag(response.ETag),
      ...(response.VersionId ? { versionId: response.VersionId } : {}),
    };
  }

  async abortMultipartUpload(input: MultipartUploadReference): Promise<void> {
    assertManagedMediaObjectKey(input.objectKey);
    try {
      await this.#client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucketName,
          Key: input.objectKey,
          UploadId: input.uploadId,
        }),
      );
    } catch (error) {
      const candidate = error as {
        name?: unknown;
        $metadata?: { httpStatusCode?: unknown };
      };
      if (
        candidate.name !== "NoSuchUpload" &&
        candidate.$metadata?.httpStatusCode !== 404
      ) {
        throw error;
      }
    }
  }

  async findSourceObject(
    objectKey: StoredSourceObject["objectKey"],
  ): Promise<StoredSourceObject | undefined> {
    assertManagedMediaObjectKey(objectKey);
    let response;
    try {
      response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucketName, Key: objectKey }),
      );
    } catch (error) {
      const candidate = error as {
        name?: unknown;
        $metadata?: { httpStatusCode?: unknown };
      };
      if (
        candidate.name === "NotFound" ||
        candidate.$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw error;
    }
    if (
      response.ContentLength === undefined ||
      !response.ContentType ||
      !response.ETag
    ) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "Stored source object is missing required size, type, or ETag",
      );
    }
    // Where Cap asked for SSE-KMS, an object that came back without it was not
    // written the way we authorized and must not be treated as ours.
    if (
      this.#kmsKeyArn &&
      (response.ServerSideEncryption !== "aws:kms" || !response.SSEKMSKeyId)
    ) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "Stored source object is missing required SSE-KMS metadata",
      );
    }
    return {
      objectKey,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      etag: s3EntityTag(response.ETag),
      ...(this.#kmsKeyArn && response.SSEKMSKeyId
        ? { encryption: "aws:kms" as const, kmsKeyId: response.SSEKMSKeyId }
        : {}),
      ...(response.VersionId ? { versionId: response.VersionId } : {}),
    };
  }

  async headSourceObject(
    objectKey: StoredSourceObject["objectKey"],
  ): Promise<StoredSourceObject> {
    const object = await this.findSourceObject(objectKey);
    if (!object) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "Stored source object does not exist",
      );
    }
    return object;
  }

  async presignPlayback(input: {
    readonly objectKey: StoredSourceObject["objectKey"];
    readonly expiresInSeconds: number;
  }) {
    assertManagedMediaObjectKey(input.objectKey);
    assertPlaybackExpirySeconds(input.expiresInSeconds);
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#bucketName, Key: input.objectKey }),
      { expiresIn: input.expiresInSeconds },
    );
    return {
      url,
      expiresAt: new Date(
        this.#now().getTime() + input.expiresInSeconds * 1000,
      ),
    };
  }

  async deleteRecordingObjects(input: {
    readonly workspaceId: WorkspaceId;
    readonly recordingId: RecordingId;
  }): Promise<void> {
    const Prefix = buildRecordingObjectPrefix(input);
    let ContinuationToken: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucketName,
          Prefix,
          ContinuationToken,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));
      if (keys.length > 0) {
        await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucketName,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      ContinuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (ContinuationToken);
  }

  async putTextObject(input: {
    readonly objectKey: MediaObjectKey;
    readonly content: string;
    readonly contentType: string;
  }): Promise<void> {
    assertManagedMediaObjectKey(input.objectKey);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucketName,
        Key: input.objectKey,
        Body: input.content,
        ContentType: input.contentType,
        ...this.#encryption,
      }),
    );
  }

  async getTextObject(objectKey: MediaObjectKey): Promise<string | undefined> {
    assertManagedMediaObjectKey(objectKey);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucketName, Key: objectKey }),
      );
      return await response.Body?.transformToString("utf-8");
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }
}
