import { describe, expect, it } from "vitest";
import { hashApiKey } from "./service";
import { createApiKeySchema } from "./validation";

describe("api key primitives", () => {
  it("hashes keys deterministically without leaking the key", () => {
    const key = "cap_live_example";
    const hash = hashApiKey(key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key);
  });

  it("requires a meaningful name", () => {
    expect(() => createApiKeySchema.parse({ name: "a" })).toThrow();
    expect(createApiKeySchema.parse({ name: "CI integration" })).toEqual({
      name: "CI integration",
    });
  });
});
