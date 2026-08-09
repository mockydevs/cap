import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnalyticsServiceError,
  privacySafeViewerHash,
  verifyViewGrant,
} from "./service";

const previousSecret = process.env.ANALYTICS_HASH_SECRET;
afterEach(() => {
  if (previousSecret === undefined) delete process.env.ANALYTICS_HASH_SECRET;
  else process.env.ANALYTICS_HASH_SECRET = previousSecret;
});

describe("privacy-safe view identity and grants", () => {
  it("creates deterministic HMAC pseudonyms without retaining raw request identifiers", () => {
    process.env.ANALYTICS_HASH_SECRET =
      "a-secure-analytics-secret-with-32-bytes";
    const request = new Request("https://cap.test", {
      headers: { "x-real-ip": "203.0.113.4", "user-agent": "Private Browser" },
    });
    const first = privacySafeViewerHash(
      request,
      undefined,
      new Date("2026-08-09T01:00:00Z"),
    );
    const second = privacySafeViewerHash(
      request,
      undefined,
      new Date("2026-08-09T22:00:00Z"),
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("203.0.113.4");
    expect(privacySafeViewerHash(request, "user-id")).not.toBe(first);
  });

  it("verifies signed, expiring view grants and rejects tampering", () => {
    const secret = "a-secure-analytics-secret-with-32-bytes";
    process.env.ANALYTICS_HASH_SECRET = secret;
    const sessionId = "c24d9ba8-ca43-4906-a459-6dd7a9b2f013";
    const expiry = 2_000_000_000;
    const payload = `${sessionId}.${expiry}`;
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    expect(
      verifyViewGrant(`${payload}.${signature}`, new Date(1_900_000_000_000)),
    ).toBe(sessionId);
    expect(() =>
      verifyViewGrant(`${payload}.${signature}x`, new Date(1_900_000_000_000)),
    ).toThrow(AnalyticsServiceError);
    expect(() =>
      verifyViewGrant(`${payload}.${signature}`, new Date(2_100_000_000_000)),
    ).toThrow(AnalyticsServiceError);
  });
});
