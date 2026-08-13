import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  credentialEncryptionConfigured,
  credentialEncryptionContext,
  CredentialEncryptionError,
  decryptCredential,
  encryptCredential,
  secretFingerprint,
} from "../src/index";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

function setLocalKey(variable: string, key = randomBytes(32)): string {
  const encoded = key.toString("base64");
  process.env[variable] = encoded;
  return encoded;
}

afterEach(() => {
  delete process.env.AI_CREDENTIALS_LOCAL_KEY;
  delete process.env.WEBHOOK_SECRETS_LOCAL_KEY;
  delete process.env.AI_CREDENTIALS_KMS_KEY_ARN;
});

describe("credential encryption context", () => {
  it("binds a ciphertext to one workspace and purpose", () => {
    expect(
      credentialEncryptionContext(WORKSPACE, "ai-provider-credential"),
    ).toEqual({
      application: "cap",
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
    });
  });
});

describe("local key envelope", () => {
  it("round-trips a secret and reports the key it used", async () => {
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    expect(sealed.keyReference).toMatch(/^local:aes-256-gcm:[0-9a-f]{12}$/);
    expect(sealed.ciphertext).not.toContain("sk-example-key");
    expect(sealed.fingerprint).toBe(secretFingerprint("sk-example-key"));
    await expect(
      decryptCredential({
        workspaceId: WORKSPACE,
        purpose: "ai-provider-credential",
        ciphertext: sealed.ciphertext,
        keyReference: sealed.keyReference,
      }),
    ).resolves.toBe("sk-example-key");
  });

  it("refuses to read a credential belonging to another workspace", async () => {
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    await expect(
      decryptCredential({
        workspaceId: OTHER_WORKSPACE,
        purpose: "ai-provider-credential",
        ciphertext: sealed.ciphertext,
        keyReference: sealed.keyReference,
      }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("refuses to read a credential sealed for a different purpose", async () => {
    const shared = setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    process.env.WEBHOOK_SECRETS_LOCAL_KEY = shared;
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    await expect(
      decryptCredential({
        workspaceId: WORKSPACE,
        purpose: "webhook-endpoint-secret",
        ciphertext: sealed.ciphertext,
        keyReference: sealed.keyReference,
      }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("rejects tampered ciphertext instead of returning damaged plaintext", async () => {
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    const raw = Buffer.from(sealed.ciphertext, "base64");
    const last = raw.byteLength - 1;
    raw.writeUInt8(raw.readUInt8(last) ^ 0xff, last);
    await expect(
      decryptCredential({
        workspaceId: WORKSPACE,
        purpose: "ai-provider-credential",
        ciphertext: raw.toString("base64"),
        keyReference: sealed.keyReference,
      }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("names the problem when the configured key is not the one used", async () => {
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    await expect(
      decryptCredential({
        workspaceId: WORKSPACE,
        purpose: "ai-provider-credential",
        ciphertext: sealed.ciphertext,
        keyReference: sealed.keyReference,
      }),
    ).rejects.toMatchObject({ code: "KEY_MISMATCH" });
  });

  it("rejects a local key that is not 32 bytes", async () => {
    process.env.AI_CREDENTIALS_LOCAL_KEY = randomBytes(16).toString("base64");
    await expect(
      encryptCredential({
        workspaceId: WORKSPACE,
        purpose: "ai-provider-credential",
        secret: "sk-example-key",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LOCAL_KEY" });
  });
});

describe("configuration reporting", () => {
  it("is unavailable until a key is configured", async () => {
    expect(credentialEncryptionConfigured("ai-provider-credential")).toBe(
      false,
    );
    await expect(
      encryptCredential({
        workspaceId: WORKSPACE,
        purpose: "ai-provider-credential",
        secret: "sk-example-key",
      }),
    ).rejects.toBeInstanceOf(CredentialEncryptionError);
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    expect(credentialEncryptionConfigured("ai-provider-credential")).toBe(true);
  });

  it("treats a declared-but-blank key variable as unset", async () => {
    // .env templates ship these declared and empty.
    process.env.AI_CREDENTIALS_KMS_KEY_ARN = "";
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    expect(credentialEncryptionConfigured("ai-provider-credential")).toBe(true);
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
    });
    expect(sealed.keyReference).toMatch(/^local:aes-256-gcm:/);
  });

  it("prefers KMS when both schemes are configured", async () => {
    setLocalKey("AI_CREDENTIALS_LOCAL_KEY");
    process.env.AI_CREDENTIALS_KMS_KEY_ARN = "arn:aws:kms:eu-west-1:1:key/abc";
    const kms = {
      send: async () => ({ CiphertextBlob: Buffer.from("sealed") }),
    };
    const sealed = await encryptCredential({
      workspaceId: WORKSPACE,
      purpose: "ai-provider-credential",
      secret: "sk-example-key",
      kms: kms as never,
    });
    expect(sealed.keyReference).toBe("arn:aws:kms:eu-west-1:1:key/abc");
  });
});
