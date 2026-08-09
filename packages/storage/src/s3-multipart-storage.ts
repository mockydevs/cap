import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3_MAX_MULTIPART_PART_BYTES,
  S3_MAX_MULTIPART_PARTS,
  s3EntityTag,
  sha256Base64,
  type CompletedUploadPart,
} from "@cap/domain";
import { assertManagedMediaObjectKey } from "./media-object-key";
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
  type StoredSourceObject,
} from "./multipart-storage";

export interface S3MultipartStorageOptions {
  readonly client: S3Client;
  readonly bucketName: string;
  readonly kmsKeyArn: string;
  readonly now?: () => Date;
}

function assertOptions(options: S3MultipartStorageOptions): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucketName) ||
    options.bucketName.includes("..")
  ) {
    throw new StorageContractError("INVALID_CONFIG", "Invalid S3 bucket name");
  }
  if (!options.kmsKeyArn.startsWith("arn:aws:kms:")) {
    throw new StorageContractError(
      "INVALID_CONFIG",
      "AWS_KMS_KEY_ARN must be a KMS ARN",
    );
  }
}

/** AWS S3 production implementation. It deliberately has no endpoint/path-style options. */
export class S3MultipartStorage
  implements MultipartObjectStorage, PlaybackObjectStorage
{
  readonly #client: S3Client;
  readonly #bucketName: string;
  readonly #kmsKeyArn: string;
  readonly #now: () => Date;

  constructor(options: S3MultipartStorageOptions) {
    assertOptions(options);
    this.#client = options.client;
    this.#bucketName = options.bucketName;
    this.#kmsKeyArn = options.kmsKeyArn;
    this.#now = options.now ?? (() => new Date());
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
        ChecksumAlgorithm: "SHA256",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.#kmsKeyArn,
        BucketKeyEnabled: true,
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
    const url = await getSignedUrl(
      this.#client,
      new UploadPartCommand({
        Bucket: this.#bucketName,
        Key: input.objectKey,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        ContentLength: input.contentLength,
        ChecksumSHA256: input.checksumSha256,
      }),
      {
        expiresIn: input.expiresInSeconds,
        // Bind the digest as a required request header instead of a mutable query value.
        unhoistableHeaders: new Set([checksumHeader]),
      },
    );

    return {
      url,
      method: "PUT",
      expiresAt: new Date(
        this.#now().getTime() + input.expiresInSeconds * 1000,
      ),
      requiredHeaders: Object.freeze({
        [checksumHeader]: input.checksumSha256,
      }),
    };
  }

  async listUploadedParts(
    input: MultipartUploadReference,
  ): Promise<readonly CompletedUploadPart[]> {
    assertManagedMediaObjectKey(input.objectKey);
    const parts: CompletedUploadPart[] = [];
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
          !part.ChecksumSHA256
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
          checksumSha256: sha256Base64(part.ChecksumSHA256),
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
            ChecksumSHA256: part.checksumSha256,
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
      !response.ETag ||
      response.ServerSideEncryption !== "aws:kms" ||
      !response.SSEKMSKeyId
    ) {
      throw new StorageContractError(
        "INVALID_S3_RESPONSE",
        "Stored source object is missing required size, type, ETag, or SSE-KMS metadata",
      );
    }
    return {
      objectKey,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      etag: s3EntityTag(response.ETag),
      encryption: "aws:kms",
      kmsKeyId: response.SSEKMSKeyId,
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
}
