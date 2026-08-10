import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { webhookEndpoints, webhookOutbox } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import type { Actor } from "../auth/session";
import { encryptWebhookSecret, generateWebhookSecret } from "./crypto";

export const WEBHOOK_EVENTS = [
  "recording.ready",
  "recording.deleted",
  "transcript.ready",
  "ai_artifact.created",
  "comment.created",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export class WebhookServiceError extends Error {
  readonly code: "WEBHOOK_NOT_FOUND" | "WEBHOOK_ENCRYPTION_UNAVAILABLE";
  readonly status: number;

  constructor(code: WebhookServiceError["code"], status: number) {
    super(code);
    this.name = "WebhookServiceError";
    this.code = code;
    this.status = status;
  }
}

type OutboxExecutor = Pick<ReturnType<typeof db>, "insert">;

/** Records a domain event for the webhook-worker outbox dispatcher to deliver. */
export async function emitWebhookEvent(
  executor: OutboxExecutor,
  input: {
    event: WebhookEventName;
    workspaceId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(webhookOutbox).values({
    event: input.event,
    workspaceId: input.workspaceId,
    aggregateId: input.aggregateId,
    payload: input.payload,
  });
}

export async function listWebhookEndpoints(workspaceId: string) {
  return db()
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      description: webhookEndpoints.description,
      secretFingerprint: webhookEndpoints.secretFingerprint,
      enabledEvents: webhookEndpoints.enabledEvents,
      status: webhookEndpoints.status,
      createdAt: webhookEndpoints.createdAt,
      lastDeliveryAt: webhookEndpoints.lastDeliveryAt,
      lastDeliveryStatus: webhookEndpoints.lastDeliveryStatus,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspaceId))
    .orderBy(desc(webhookEndpoints.createdAt));
}

export async function createWebhookEndpoint(
  actor: Actor,
  input: {
    url: string;
    description?: string | undefined;
    enabledEvents: WebhookEventName[];
  },
) {
  const secret = generateWebhookSecret();
  let encrypted: Awaited<ReturnType<typeof encryptWebhookSecret>>;
  try {
    encrypted = await encryptWebhookSecret(actor.workspaceId, secret);
  } catch {
    throw new WebhookServiceError("WEBHOOK_ENCRYPTION_UNAVAILABLE", 503);
  }
  return db().transaction(async (tx) => {
    const [created] = await tx
      .insert(webhookEndpoints)
      .values({
        workspaceId: actor.workspaceId,
        url: input.url,
        description: input.description ?? null,
        encryptedSecret: encrypted.ciphertext,
        secretKeyArn: encrypted.keyArn,
        secretFingerprint: encrypted.fingerprint,
        enabledEvents: input.enabledEvents,
        createdBy: actor.userId,
      })
      .returning({ id: webhookEndpoints.id });
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "webhook_endpoint.created",
      targetType: "webhook_endpoint",
      targetId: created!.id,
      metadata: { url: input.url, enabledEvents: input.enabledEvents },
    });
    return { id: created!.id, secret };
  });
}

export async function deleteWebhookEndpoint(actor: Actor, id: string) {
  return db().transaction(async (tx) => {
    const [deleted] = await tx
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.workspaceId, actor.workspaceId),
        ),
      )
      .returning({ id: webhookEndpoints.id });
    if (!deleted) throw new WebhookServiceError("WEBHOOK_NOT_FOUND", 404);
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "webhook_endpoint.deleted",
      targetType: "webhook_endpoint",
      targetId: id,
    });
  });
}
