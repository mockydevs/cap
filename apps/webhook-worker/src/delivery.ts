import { createHmac } from "node:crypto";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { Pool } from "pg";

interface DeliveryRow {
  id: string;
  event: string;
  payload: unknown;
  endpoint_id: string;
  url: string;
  encrypted_secret: string;
  secret_key_arn: string;
  workspace_id: string;
}

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class WebhookDeliveryFailedError extends Error {}

/** Throws on a failed/unreachable endpoint so BullMQ's attempts+backoff retry it. */
export async function deliverWebhook(
  pool: Pool,
  kms: KMSClient,
  deliveryId: string,
): Promise<void> {
  const { rows } = await pool.query<DeliveryRow>(
    `SELECT d.id, d.event, d.payload, e.id AS endpoint_id, e.url,
            e.encrypted_secret, e.secret_key_arn, e.workspace_id
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.webhook_endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  const delivery = rows[0];
  if (!delivery) return;

  const decrypted = await kms.send(
    new DecryptCommand({
      KeyId: delivery.secret_key_arn,
      CiphertextBlob: Buffer.from(delivery.encrypted_secret, "base64"),
      EncryptionContext: {
        application: "cap",
        workspaceId: delivery.workspace_id,
        purpose: "webhook-endpoint-secret",
      },
    }),
  );
  if (!decrypted.Plaintext)
    throw new Error("Webhook secret could not be decrypted");
  const secret = Buffer.from(decrypted.Plaintext).toString("utf8");

  const body = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    createdAt: new Date().toISOString(),
    data: delivery.payload,
  });
  const signature = signWebhookPayload(secret, body);

  let responseStatus: number | null = null;
  let responseExcerpt = "";
  let succeeded = false;
  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cap-event": delivery.event,
        "x-cap-delivery-id": delivery.id,
        "x-cap-signature-256": signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = response.status;
    responseExcerpt = (await response.text()).slice(0, 2_000);
    succeeded = response.ok;
  } catch (error) {
    responseExcerpt =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "delivery failed";
  }

  await pool.query(
    `UPDATE webhook_deliveries
     SET status = $2, attempts = attempts + 1, response_status = $3,
         response_excerpt = $4,
         delivered_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE delivered_at END
     WHERE id = $1`,
    [
      delivery.id,
      succeeded ? "SUCCEEDED" : "FAILED",
      responseStatus,
      responseExcerpt,
    ],
  );
  await pool.query(
    "UPDATE webhook_endpoints SET last_delivery_at = now(), last_delivery_status = $2 WHERE id = $1",
    [delivery.endpoint_id, succeeded ? "SUCCEEDED" : "FAILED"],
  );

  if (!succeeded)
    throw new WebhookDeliveryFailedError(
      `Webhook delivery failed with status ${responseStatus ?? "network error"}`,
    );
}
