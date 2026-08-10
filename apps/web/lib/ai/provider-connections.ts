import { createHash } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { aiProviderConnections, aiProviderRoutes } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import type { Actor } from "../auth/session";
import { AiServiceError } from "./service";

const keyArn = () => {
  const value = process.env.AI_CREDENTIALS_KMS_KEY_ARN;
  if (!value)
    throw new AiServiceError("AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE", 503);
  return value;
};
const kms = () =>
  new KMSClient(
    process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
  );
const context = (workspaceId: string) => ({
  application: "cap",
  workspaceId,
  purpose: "ai-provider-credential",
});
export async function encryptProviderCredential(
  workspaceId: string,
  secret: string,
) {
  const KeyId = keyArn();
  const result = await kms().send(
    new EncryptCommand({
      KeyId,
      Plaintext: Buffer.from(secret),
      EncryptionContext: context(workspaceId),
    }),
  );
  if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
  return {
    ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
    keyArn: result.KeyId ?? KeyId,
    fingerprint: createHash("sha256").update(secret).digest("hex").slice(-12),
  };
}

export async function decryptProviderCredential(input: {
  workspaceId: string;
  ciphertext: string;
  keyArn: string;
}) {
  const result = await kms().send(
    new DecryptCommand({
      KeyId: input.keyArn,
      CiphertextBlob: Buffer.from(input.ciphertext, "base64"),
      EncryptionContext: context(input.workspaceId),
    }),
  );
  if (!result.Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(result.Plaintext).toString("utf8");
}

const endpoint = (provider: string, baseUrl?: string | null) =>
  baseUrl ??
  (provider === "ANTHROPIC"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1");

export async function validateProviderCredential(input: {
  provider: "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE";
  baseUrl?: string | undefined;
  apiKey: string;
}) {
  const root = endpoint(input.provider, input.baseUrl).replace(/\/$/, "");
  const response = await fetch(
    `${root}${input.provider === "ANTHROPIC" ? "/v1/models" : "/models"}`,
    {
      headers:
        input.provider === "ANTHROPIC"
          ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new AiServiceError("AI_PROVIDER_VALIDATION_FAILED", 400);
}

export async function listProviderConnections(actor: Actor) {
  const connections = await db()
    .select({
      id: aiProviderConnections.id,
      provider: aiProviderConnections.provider,
      displayName: aiProviderConnections.displayName,
      baseUrl: aiProviderConnections.baseUrl,
      credentialFingerprint: aiProviderConnections.credentialFingerprint,
      allowedCapabilities: aiProviderConnections.allowedCapabilities,
      allowedModels: aiProviderConnections.allowedModels,
      defaultModel: aiProviderConnections.defaultModel,
      dataRegion: aiProviderConnections.dataRegion,
      status: aiProviderConnections.status,
      lastValidatedAt: aiProviderConnections.lastValidatedAt,
      lastUsedAt: aiProviderConnections.lastUsedAt,
    })
    .from(aiProviderConnections)
    .where(eq(aiProviderConnections.workspaceId, actor.workspaceId));
  const routes = await db()
    .select()
    .from(aiProviderRoutes)
    .where(eq(aiProviderRoutes.workspaceId, actor.workspaceId));
  return { connections, routes };
}

export async function createProviderConnection(
  actor: Actor,
  input: {
    provider: "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE";
    displayName: string;
    apiKey: string;
    baseUrl?: string | undefined;
    allowedCapabilities: Array<"ANALYSIS" | "EMBEDDINGS" | "TRANSCRIPTION">;
    allowedModels: string[];
    defaultModel: string;
    dataRegion?: string | undefined;
  },
) {
  await validateProviderCredential(input);
  const encrypted = await encryptProviderCredential(
    actor.workspaceId,
    input.apiKey,
  );
  return db().transaction(async (tx) => {
    const [created] = await tx
      .insert(aiProviderConnections)
      .values({
        workspaceId: actor.workspaceId,
        provider: input.provider,
        displayName: input.displayName,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        encryptedCredential: encrypted.ciphertext,
        credentialKeyArn: encrypted.keyArn,
        credentialFingerprint: encrypted.fingerprint,
        allowedCapabilities: input.allowedCapabilities,
        allowedModels: input.allowedModels,
        defaultModel: input.defaultModel,
        ...(input.dataRegion ? { dataRegion: input.dataRegion } : {}),
        lastValidatedAt: new Date(),
        createdBy: actor.userId,
      })
      .returning({ id: aiProviderConnections.id });
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "ai_provider_connection.created",
      targetType: "ai_provider_connection",
      targetId: created!.id,
      metadata: { provider: input.provider, displayName: input.displayName },
    });
    return created!;
  });
}

export async function revokeProviderConnection(actor: Actor, id: string) {
  return db().transaction(async (tx) => {
    const [updated] = await tx
      .update(aiProviderConnections)
      .set({
        status: "REVOKED",
        encryptedCredential: "revoked",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiProviderConnections.id, id),
          eq(aiProviderConnections.workspaceId, actor.workspaceId),
          eq(aiProviderConnections.status, "ACTIVE"),
        ),
      )
      .returning({ id: aiProviderConnections.id });
    if (!updated) throw new AiServiceError("AI_NOT_FOUND", 404);
    await recordAuditEvent(tx, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "ai_provider_connection.revoked",
      targetType: "ai_provider_connection",
      targetId: updated.id,
    });
    return updated;
  });
}

export async function setProviderRoute(
  actor: Actor,
  input: {
    purpose: "ANALYSIS" | "EMBEDDINGS" | "TRANSCRIPTION";
    connectionId: string;
    model: string;
  },
) {
  const [connection] = await db()
    .select()
    .from(aiProviderConnections)
    .where(
      and(
        eq(aiProviderConnections.id, input.connectionId),
        eq(aiProviderConnections.workspaceId, actor.workspaceId),
        eq(aiProviderConnections.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (
    !connection ||
    !connection.allowedCapabilities.includes(input.purpose) ||
    !connection.allowedModels.includes(input.model)
  )
    throw new AiServiceError("AI_NOT_FOUND", 404);
  return (
    await db()
      .insert(aiProviderRoutes)
      .values({
        ...input,
        workspaceId: actor.workspaceId,
        updatedBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: [aiProviderRoutes.workspaceId, aiProviderRoutes.purpose],
        set: {
          connectionId: input.connectionId,
          model: input.model,
          updatedBy: actor.userId,
          updatedAt: new Date(),
        },
      })
      .returning()
  )[0]!;
}
