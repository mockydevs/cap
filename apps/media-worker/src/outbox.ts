import type { Queue } from "bullmq";
import type { Pool } from "pg";
import {
  mediaProcessingJobOptions,
  mediaProcessingJobSchema,
  type MediaProcessingJob,
} from "@cap/queue";

type OutboxRow = { id: string; payload: unknown };

/** Publishes committed database events. Duplicate publication is harmless because job IDs are stable. */
export async function dispatchProcessingOutbox(
  pool: Pool,
  queue: Queue<MediaProcessingJob>,
  limit = 25,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<OutboxRow>(
      "SELECT id, payload FROM processing_outbox WHERE topic = 'MEDIA_PROCESSING' AND published_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [limit],
    );
    for (const row of rows.rows) {
      const payload = mediaProcessingJobSchema.parse(row.payload);
      await queue.add(
        "process-recording",
        payload,
        mediaProcessingJobOptions(
          payload.recordingId,
          payload.processingVersion,
        ),
      );
      await client.query(
        "UPDATE processing_outbox SET published_at = now() WHERE id = $1",
        [row.id],
      );
    }
    await client.query("COMMIT");
    return rows.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
