/**
 * Confirms every object the database references actually exists in the
 * configured bucket.
 *
 * A bucket-to-bucket copy tool can only tell you it copied what it found; it
 * knows nothing about which objects this deployment still needs. Run this
 * after a storage migration, pointed at the *new* bucket, to prove no
 * recording was left behind — a missing source object means a recording that
 * can never be reprocessed, and a missing playback asset means one that can
 * never be watched.
 *
 *   pnpm --filter @cap/web storage:check-objects
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createStorageClient } from "@cap/storage";
import { eq, ne } from "drizzle-orm";
import { db } from "../db/client";
import {
  captionTracks,
  recordingAssets,
  recordings,
  transcripts,
} from "../db/schema";

interface Expected {
  readonly kind: string;
  readonly key: string;
  readonly recordingId: string;
}

async function expectedObjects(): Promise<Expected[]> {
  const sources = await db()
    .select({ id: recordings.id, key: recordings.sourceObjectKey })
    .from(recordings)
    .where(ne(recordings.status, "DELETED"));
  const assets = await db()
    .select({
      recordingId: recordingAssets.recordingId,
      key: recordingAssets.objectKey,
      kind: recordingAssets.kind,
    })
    .from(recordingAssets)
    .innerJoin(recordings, eq(recordings.id, recordingAssets.recordingId))
    .where(ne(recordings.status, "DELETED"));
  // Caption tracks hang off a transcript, which is what carries the recording.
  const captions = await db()
    .select({
      recordingId: transcripts.recordingId,
      key: captionTracks.objectKey,
    })
    .from(captionTracks)
    .innerJoin(transcripts, eq(transcripts.id, captionTracks.transcriptId));

  return [
    ...sources.map((row) => ({
      kind: "source",
      key: row.key,
      recordingId: row.id,
    })),
    ...assets.map((row) => ({
      kind: `asset:${row.kind}`,
      key: row.key,
      recordingId: row.recordingId,
    })),
    ...captions.map((row) => ({
      kind: "caption",
      key: row.key,
      recordingId: row.recordingId,
    })),
  ];
}

async function main() {
  const bucket = process.env.AWS_S3_BUCKET_NAME?.trim();
  if (!bucket) {
    console.error("AWS_S3_BUCKET_NAME is not set.");
    process.exit(2);
  }
  const client = createStorageClient();
  const expected = await expectedObjects();
  console.log(`Checking ${expected.length} object(s) in ${bucket}…`);

  const missing: Expected[] = [];
  // Sequential on purpose: this runs once, after a migration, and a burst of
  // HEADs against a freshly populated bucket is not worth rate-limit risk.
  for (const object of expected) {
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: object.key }),
      );
    } catch {
      missing.push(object);
    }
  }

  if (!missing.length) {
    console.log("Every referenced object is present.");
    return;
  }
  console.error(`\n${missing.length} object(s) missing:`);
  for (const object of missing)
    console.error(
      `  ${object.kind}  recording=${object.recordingId}  ${object.key}`,
    );
  console.error(
    "\nDo not decommission the old bucket until these are copied across.",
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Object check failed to run:", error);
    process.exitCode = 2;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
