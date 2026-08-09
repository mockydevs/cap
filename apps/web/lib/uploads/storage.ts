import { S3Client } from "@aws-sdk/client-s3";
import { S3MultipartStorage } from "@cap/storage";

let instance: S3MultipartStorage | undefined;

/** Production AWS storage. Credentials use the AWS default provider chain. */
export function uploadStorage(): S3MultipartStorage {
  if (instance) return instance;

  const region = process.env.AWS_REGION;
  const bucketName = process.env.AWS_S3_BUCKET_NAME;
  const kmsKeyArn = process.env.AWS_KMS_KEY_ARN;
  if (!region || !bucketName || !kmsKeyArn) {
    throw new Error("AWS_UPLOAD_STORAGE_NOT_CONFIGURED");
  }

  instance = new S3MultipartStorage({
    client: new S3Client({ region }),
    bucketName,
    kmsKeyArn,
  });
  return instance;
}
