/**
 * Applies the CORS rule the browser upload path requires, then re-verifies it.
 *
 * Separate from `storage:verify` because this one writes: it needs
 * `s3:PutBucketCors` on the bucket. Run it once per bucket, and again whenever
 * the application origin changes.
 *
 *   pnpm --filter @cap/web storage:apply-cors
 *
 * The same call is what a customer-owned-bucket flow would make at connection
 * time, so that a connection which cannot serve uploads is never saved.
 */
import { PutBucketCorsCommand } from "@aws-sdk/client-s3";
import {
  createStorageClient,
  describeCorsVerdict,
  requiredCorsRule,
  verifyBucketCors,
} from "@cap/storage";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set; cannot configure storage.`);
    process.exit(2);
  }
  return value;
}

function bucketUrl(bucket: string): string {
  const endpoint = process.env.AWS_S3_ENDPOINT?.trim();
  if (endpoint) return `${endpoint.replace(/\/$/, "")}/${bucket}/`;
  const region = process.env.AWS_REGION?.trim() ?? "us-east-1";
  return `https://${bucket}.s3.${region}.amazonaws.com/`;
}

async function main() {
  const bucket = required("AWS_S3_BUCKET_NAME");
  const origin = new URL(required("NEXT_PUBLIC_APP_URL")).origin;
  const rule = requiredCorsRule([origin]);

  console.log(`Applying CORS to ${bucket} for ${origin}…`);
  await createStorageClient().send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: [rule] },
    }),
  );

  // Trust the write only after a real preflight agrees with it.
  const verdict = await verifyBucketCors({
    bucketUrl: bucketUrl(bucket),
    origin,
  });
  console.log(describeCorsVerdict(verdict));
  if (!verdict.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    "Could not apply the CORS configuration:",
    error instanceof Error ? error.message : error,
  );
  console.error(
    "The credentials need s3:PutBucketCors, or apply infra/aws/bucket-cors.json by hand.",
  );
  process.exitCode = 2;
});
