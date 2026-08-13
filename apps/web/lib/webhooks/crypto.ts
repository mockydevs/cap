import { createHash, randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

const keyArn = () => {
  const value = process.env.WEBHOOK_SECRETS_KMS_KEY_ARN;
  if (!value) throw new Error("WEBHOOK_SECRET_ENCRYPTION_UNAVAILABLE");
  return value;
};
const kms = () =>
  new KMSClient(
    process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
  );
const context = (workspaceId: string) => ({
  application: "cap",
  workspaceId,
  purpose: "webhook-endpoint-secret",
});

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export async function encryptWebhookSecret(
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

export async function decryptWebhookSecret(input: {
  workspaceId: string;
  ciphertext: string;
  keyArn: string;
}): Promise<string> {
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
