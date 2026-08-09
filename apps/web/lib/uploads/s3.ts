import { CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function storage() {
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  if (!bucket) throw new Error("AWS_S3_BUCKET_NAME must be configured");
  const endpoint = process.env.AWS_S3_ENDPOINT;
  return { bucket, client: new S3Client({ region: process.env.AWS_REGION ?? "us-east-1", ...(endpoint ? { endpoint, forcePathStyle: true } : {}) }) };
}

export async function createPrivateMultipartUpload(objectKey: string, contentType: string) {
  const { bucket, client } = storage();
  const response = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType, ServerSideEncryption: process.env.AWS_KMS_KEY_ARN ? "aws:kms" : "AES256", ...(process.env.AWS_KMS_KEY_ARN ? { SSEKMSKeyId: process.env.AWS_KMS_KEY_ARN } : {}) }));
  if (!response.UploadId) throw new Error("S3 did not return an upload ID");
  return response.UploadId;
}

export function signUploadPart(objectKey: string, uploadId: string, partNumber: number) {
  const { bucket, client } = storage();
  return getSignedUrl(client, new UploadPartCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 300 });
}

export async function completePrivateMultipartUpload(objectKey: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  const { bucket, client } = storage();
  await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId, MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }));
  const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  return result.ContentLength;
}
