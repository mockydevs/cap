type AwsError = {
  readonly name?: unknown;
  readonly Code?: unknown;
  readonly code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
};

export function storageKmsKeyArn(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return environment.AWS_KMS_KEY_ARN?.trim() || undefined;
}

/**
 * R2 supports multipart uploads but rejects the per-part
 * `x-amz-checksum-sha256` header with NotImplemented. AWS S3 and compatible
 * stores without that known limitation retain the stronger bound checksum.
 */
export function multipartSha256ChecksumsEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const endpoint = environment.AWS_S3_ENDPOINT?.trim();
  if (!endpoint) return true;
  try {
    return !new URL(endpoint).hostname
      .toLowerCase()
      .endsWith(".r2.cloudflarestorage.com");
  } catch {
    return true;
  }
}

/** Provider-neutral write fields: request SSE-KMS only when AWS KMS is set. */
export function storageWriteEncryption(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const kmsKeyArn = storageKmsKeyArn(environment);
  return kmsKeyArn
    ? {
        ServerSideEncryption: "aws:kms" as const,
        SSEKMSKeyId: kmsKeyArn,
        BucketKeyEnabled: true,
      }
    : {};
}

/** Only a provider's explicit not-found response proves an object is absent. */
export function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as AwsError;
  if (candidate.$metadata?.httpStatusCode === 404) return true;
  return [candidate.name, candidate.Code, candidate.code].some(
    (code) => code === "NotFound" || code === "NoSuchKey",
  );
}

/** Public URL used by the browser for a bucket CORS preflight. */
export function storageBucketUrl(
  bucket: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedBucket = bucket.trim();
  if (!normalizedBucket) throw new Error("Bucket name must not be empty");
  const endpoint = environment.AWS_S3_ENDPOINT?.trim();
  if (endpoint) return `${endpoint.replace(/\/+$/, "")}/${normalizedBucket}/`;
  const region = environment.AWS_REGION?.trim() || "us-east-1";
  return `https://${normalizedBucket}.s3.${region}.amazonaws.com/`;
}
