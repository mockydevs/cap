import { describe, expect, it } from "vitest";
import { hashPassword, signupSchema, verifyPassword } from "./credentials";
import { hashSessionToken, tokenFromRequest } from "./session";

describe("authentication primitives", () => {
  it("hashes passwords with Argon2id and verifies without retaining plaintext", async () => {
    const encoded = await hashPassword("a secure passphrase");
    expect(encoded).not.toContain("a secure passphrase");
    await expect(verifyPassword(encoded, "a secure passphrase")).resolves.toBe(
      true,
    );
    await expect(verifyPassword(encoded, "wrong password")).resolves.toBe(
      false,
    );
  });

  it("normalizes email and enforces long passwords", () => {
    const result = signupSchema.parse({
      displayName: "Ada",
      workspaceName: "Research",
      email: "ADA@EXAMPLE.COM",
      password: "correct horse battery staple",
    });
    expect(result.email).toBe("ada@example.com");
    expect(() =>
      signupSchema.parse({ ...result, password: "short" }),
    ).toThrow();
  });

  it("only stores a deterministic digest and reads the exact cookie name", () => {
    expect(hashSessionToken("secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(
      tokenFromRequest(
        new Request("https://cap.test", {
          headers: { cookie: "other=x; cap_session=abc%20123" },
        }),
      ),
    ).toBe("abc 123");
  });
});
