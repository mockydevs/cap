import {
  createStorageClient,
  S3MultipartStorage,
  storageKmsKeyArn,
} from "@cap/storage";

let instance: S3MultipartStorage | undefined;

/**
 * Media storage for the web app. Any S3-compatible store works: AWS S3 needs
 * only `AWS_REGION` and `AWS_S3_BUCKET_NAME`, while Cloudflare R2, MinIO, and
 * Backblaze B2 add `AWS_S3_ENDPOINT`. `AWS_KMS_KEY_ARN` is optional and only
 * applies to AWS — see docs/OPERATIONS.md and ADR 0002.
 */
export function uploadStorage(): S3MultipartStorage {
  if (instance) return instance;

  const bucketName = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!bucketName) {
    throw new Error("AWS_UPLOAD_STORAGE_NOT_CONFIGURED");
  }
  const kmsKeyArn = storageKmsKeyArn();

  instance = new S3MultipartStorage({
    client: createStorageClient(),
    bucketName,
    ...(kmsKeyArn ? { kmsKeyArn } : {}),
  });
  return instance;
}
