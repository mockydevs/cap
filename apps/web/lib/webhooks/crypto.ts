import { randomBytes } from "node:crypto";
import { encryptCredential } from "@cap/crypto";

/**
 * Webhook signing secrets are shown to the operator once and then only ever
 * read by the delivery worker, so they are sealed with the same envelope as
 * every other workspace credential — see `@cap/crypto`.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export async function encryptWebhookSecret(
  workspaceId: string,
  secret: string,
) {
  return encryptCredential({
    workspaceId,
    purpose: "webhook-endpoint-secret",
    secret,
  });
}
