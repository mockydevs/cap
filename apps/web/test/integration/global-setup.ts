import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  PutBucketEncryptionCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";

const ENV_FILE = fileURLToPath(new URL("./.integration-env.json", import.meta.url));

const DATABASE_URL =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgresql://cap:cap@localhost:5433/cap_test";
const S3_ENDPOINT = process.env.INTEGRATION_S3_ENDPOINT ?? "http://localhost:4566";
const BUCKET_NAME = "cap-integration-test";
const REGION = "us-east-1";

/**
 * Runs once before the whole integration suite: provisions a fresh bucket
 * and KMS key against the LocalStack container from docker-compose.test.yml
 * (see docs/OPERATIONS.md), migrates postgres-test, then hands the resolved
 * env (the KMS key ARN isn't known until it's created) to test workers via
 * a JSON file that setup-env.ts loads into process.env per worker.
 */
export default async function setup() {
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const s3 = new S3Client({
    region: REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials,
  });
  const kms = new KMSClient({ region: REGION, endpoint: S3_ENDPOINT, credentials });

  await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME })).catch((error) => {
    if (!String(error).includes("BucketAlreadyOwnedByYou")) throw error;
  });
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: BUCKET_NAME,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" } },
        ],
      },
    }),
  );
  const key = await kms.send(
    new CreateKeyCommand({ Description: "cap integration test key" }),
  );
  const keyArn = key.KeyMetadata?.Arn;
  if (!keyArn) throw new Error("LocalStack did not return a KMS key ARN");

  execFileSync("npx", ["drizzle-kit", "migrate"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });

  writeFileSync(
    ENV_FILE,
    JSON.stringify({
      DATABASE_URL,
      AWS_REGION: REGION,
      AWS_S3_ENDPOINT: S3_ENDPOINT,
      AWS_S3_BUCKET_NAME: BUCKET_NAME,
      AWS_KMS_KEY_ARN: keyArn,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    }),
  );
}
