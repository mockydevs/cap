import { createHash } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Shared KMS envelope encryption for workspace-scoped secrets (AI provider
 * keys, BYO storage credentials, ...). Callers pass the EncryptionContext,
 * which must come from whichever package owns that credential's contract —
 * the same context is required to decrypt, sometimes from another process, so
 * it cannot be assembled here.
 */
export class EnvelopeEncryptionError extends Error {
  constructor(readonly code: "ENCRYPTION_UNAVAILABLE") {
    super(code);
  }
}

const kms = () =>
  new KMSClient(
    process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
  );

export function requireKeyArn(envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new EnvelopeEncryptionError("ENCRYPTION_UNAVAILABLE");
  return value;
}

export async function encryptCredential(input: {
  secret: string;
  keyArn: string;
  encryptionContext: Record<string, string>;
}) {
  const result = await kms().send(
    new EncryptCommand({
      KeyId: input.keyArn,
      Plaintext: Buffer.from(input.secret),
      EncryptionContext: input.encryptionContext,
    }),
  );
  if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
  return {
    ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
    keyArn: result.KeyId ?? input.keyArn,
    fingerprint: createHash("sha256")
      .update(input.secret)
      .digest("hex")
      .slice(-12),
  };
}

export async function decryptCredential(input: {
  ciphertext: string;
  keyArn: string;
  encryptionContext: Record<string, string>;
}): Promise<string> {
  const result = await kms().send(
    new DecryptCommand({
      KeyId: input.keyArn,
      CiphertextBlob: Buffer.from(input.ciphertext, "base64"),
      EncryptionContext: input.encryptionContext,
    }),
  );
  if (!result.Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(result.Plaintext).toString("utf8");
}
