import { S3Client } from "@aws-sdk/client-s3";

/**
 * The S3 client every Cap process uses, so provider quirks are handled once
 * rather than in each app.
 *
 * Cap targets any S3-compatible object store. AWS S3 is reached by setting only
 * `AWS_REGION`; Cloudflare R2, MinIO, and Backblaze B2 additionally set
 * `AWS_S3_ENDPOINT` (with `AWS_REGION=auto` for R2).
 */
export function createStorageClient(): S3Client {
  const endpoint = process.env.AWS_S3_ENDPOINT;
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(endpoint
      ? {
          endpoint,
          forcePathStyle: true,
          // Since v3.729 the SDK attaches a CRC32 checksum to every request.
          // R2, MinIO, and B2 reject that header, so ask for checksums only
          // where the operation requires them. Multipart parts are unaffected:
          // they carry the SHA-256 digest Cap sets explicitly.
          requestChecksumCalculation: "WHEN_REQUIRED" as const,
          responseChecksumValidation: "WHEN_REQUIRED" as const,
        }
      : {}),
  });
}
