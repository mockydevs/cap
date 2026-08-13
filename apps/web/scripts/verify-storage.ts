/**
 * Checks that the configured bucket will actually accept a browser upload.
 *
 * Server-side credentials being correct is not enough: recordings are sent
 * from the browser straight to object storage, so the bucket itself has to
 * permit the application's origin. When it does not, the only symptom is a
 * bare "Failed to fetch" at the moment someone finishes recording — which is
 * the worst possible place to discover it.
 *
 * Run after any deployment that changes the bucket, the origin, or the
 * storage provider:
 *   pnpm --filter @cap/web storage:verify
 */
import {
  describeCorsVerdict,
  requiredCorsRule,
  storageBucketUrl,
  verifyBucketCors,
} from "@cap/storage";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set; cannot verify storage.`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const bucket = required("AWS_S3_BUCKET_NAME");
  const origin = new URL(required("NEXT_PUBLIC_APP_URL")).origin;
  const url = storageBucketUrl(bucket);

  console.log(`Bucket:  ${url}`);
  console.log(`Origin:  ${origin}`);

  const verdict = await verifyBucketCors({ bucketUrl: url, origin });
  console.log(`\n${describeCorsVerdict(verdict)}`);

  if (verdict.ok) return;

  console.log("\nApply this CORS configuration to the bucket:\n");
  console.log(JSON.stringify([requiredCorsRule([origin])], null, 2));
  console.log(
    `\nAWS:  aws s3api put-bucket-cors --bucket ${bucket} --cors-configuration file://cors.json`,
  );
  console.log(
    "Cloudflare R2:  R2 dashboard > bucket > Settings > CORS policy.\n",
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("Storage verification failed to run:", error);
  process.exitCode = 2;
});
