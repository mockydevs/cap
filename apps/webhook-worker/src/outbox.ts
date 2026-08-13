import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { webhookDeliveryJobOptions, type WebhookDeliveryJob } from "@cap/queue";

interface OutboxRow {
  id: string;
  event: string;
  workspace_id: string;
  payload: unknown;
}

/**
 * Fans a committed domain event out to every active endpoint subscribed to
 * it, then publishes one delivery job per endpoint. Mirrors the media-worker
 * processing outbox: FOR UPDATE SKIP LOCKED keeps this safe with multiple
 * dispatcher instances, and re-dispatch of an already-published row is
 * harmless because delivery jobs are keyed by delivery ID.
 */
export async function dispatchWebhookOutbox(
  pool: Pool,
  queue: Queue<WebhookDeliveryJob>,
  limit = 50,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<OutboxRow>(
      "SELECT id, event, workspace_id, payload FROM webhook_outbox WHERE published_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [limit],
    );
    for (const row of rows.rows) {
      const endpoints = await client.query<{ id: string }>(
        "SELECT id FROM webhook_endpoints WHERE workspace_id = $1 AND status = 'ACTIVE' AND enabled_events @> $2::jsonb",
        [row.workspace_id, JSON.stringify([row.event])],
      );
      for (const endpoint of endpoints.rows) {
        const delivery = await client.query<{ id: string }>(
          "INSERT INTO webhook_deliveries (webhook_endpoint_id, workspace_id, event, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING id",
          [
            endpoint.id,
            row.workspace_id,
            row.event,
            JSON.stringify(row.payload),
          ],
        );
        const deliveryId = delivery.rows[0]!.id;
        await queue.add(
          "deliver",
          { deliveryId },
          webhookDeliveryJobOptions(deliveryId),
        );
      }
      await client.query(
        "UPDATE webhook_outbox SET published_at = now() WHERE id = $1",
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
