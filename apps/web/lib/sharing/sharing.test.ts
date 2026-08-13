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

  it("only allows expiry on link shares", () => {
    expect(() =>
      updateSharingSchema.parse({ visibility: "PUBLIC", expiresInHours: 24 }),
    ).toThrow();
    expect(() =>
      updateSharingSchema.parse({ visibility: "PRIVATE", expiresInHours: 24 }),
    ).toThrow();
    expect(
      updateSharingSchema.parse({ visibility: "LINK", expiresInHours: 24 }),
    ).toMatchObject({ visibility: "LINK", expiresInHours: 24 });
  });

  it("no longer accepts a password-protected mode", () => {
    expect(() =>
      updateSharingSchema.parse({ visibility: "PASSWORD" }),
    ).toThrow();
  });
});
