import { createHash } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Shared KMS envelope encryption for workspace-scoped secrets (AI provider
 * keys, BYO storage credentials, ...). `purpose` is folded into the KMS
 * EncryptionContext so a ciphertext minted for one purpose can never be
 * decrypted under another, even if two features reuse the same key ARN.
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

const context = (workspaceId: string, purpose: string) => ({
  application: "cap",
  workspaceId,
  purpose,
});

export function requireKeyArn(envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new EnvelopeEncryptionError("ENCRYPTION_UNAVAILABLE");
  return value;
}

export async function encryptCredential(input: {
  workspaceId: string;
  secret: string;
  keyArn: string;
  purpose: string;
}) {
  const result = await kms().send(
    new EncryptCommand({
      KeyId: input.keyArn,
      Plaintext: Buffer.from(input.secret),
      EncryptionContext: context(input.workspaceId, input.purpose),
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
  workspaceId: string;
  ciphertext: string;
  keyArn: string;
  purpose: string;
}): Promise<string> {
  const result = await kms().send(
    new DecryptCommand({
      KeyId: input.keyArn,
      CiphertextBlob: Buffer.from(input.ciphertext, "base64"),
      EncryptionContext: context(input.workspaceId, input.purpose),
    }),
  );
  if (!result.Plaintext) throw new Error("KMS returned no plaintext");
  return Buffer.from(result.Plaintext).toString("utf8");
}
