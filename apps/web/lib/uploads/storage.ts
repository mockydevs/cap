import { S3Client } from "@aws-sdk/client-s3";
import { S3MultipartStorage } from "@cap/storage";

let instance: S3MultipartStorage | undefined;

/**
 * Production AWS storage by default (credentials via the AWS default
 * provider chain). AWS_S3_ENDPOINT switches to path-style addressing for a
 * local S3-compatible target — contract/integration tests only, per ADR
 * 0001; production never sets it.
 */
export function uploadStorage(): S3MultipartStorage {
  if (instance) return instance;

  const region = process.env.AWS_REGION;
  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  const kmsKeyArn = process.env.AWS_KMS_KEY_ARN;
  if (!region || !bucketName || !kmsKeyArn) {
    throw new Error("AWS_UPLOAD_STORAGE_NOT_CONFIGURED");
  }
  const endpoint = process.env.AWS_S3_ENDPOINT;

  instance = new S3MultipartStorage({
    client: new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    }),
    bucketName,
    kmsKeyArn,
  });
  return instance;
}
