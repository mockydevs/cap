import { describe, expect, it } from "vitest";
import { generateShareToken, hashShareToken } from "./service";
import { updateSharingSchema } from "./validation";

describe("share-link primitives", () => {
  it("generates 256-bit URL-safe bearer tokens and stores only deterministic hashes", () => {
    const first = generateShareToken();
    const second = generateShareToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(hashShareToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashShareToken(first)).not.toContain(first);
  });

  it("requires passwords and only allows expiry on link modes", () => {
    expect(() =>
      updateSharingSchema.parse({ visibility: "PASSWORD" }),
    ).toThrow();
    expect(() =>
      updateSharingSchema.parse({ visibility: "PUBLIC", expiresInHours: 24 }),
    ).toThrow();
    expect(
      updateSharingSchema.parse({
        visibility: "PASSWORD",
        password: "correct horse battery staple",
        expiresInHours: 24,
      }),
    ).toMatchObject({ visibility: "PASSWORD", expiresInHours: 24 });
  });
});
