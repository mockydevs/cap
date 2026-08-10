import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "../src/delivery";

describe("webhook payload signing", () => {
  it("produces a deterministic sha256 HMAC prefixed signature", () => {
    const secret = "whsec_example";
    const body = JSON.stringify({ hello: "world" });
    const signature = signWebhookPayload(secret, body);
    expect(signature).toBe(
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
  });

  it("changes when the secret or body changes", () => {
    const body = JSON.stringify({ hello: "world" });
    const a = signWebhookPayload("secret-a", body);
    const b = signWebhookPayload("secret-b", body);
    const c = signWebhookPayload("secret-a", JSON.stringify({ hello: "moon" }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
