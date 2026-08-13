import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Workspace secrets that Cap stores encrypted and reads back from a different
 * process than the one that wrote them.
 *
 * Everything about the envelope lives in this package: the binding context, the
 * two supported key schemes, and the reference recorded alongside each
 * ciphertext. The web app encrypts and the workers decrypt, so a difference of
 * one field between them would make stored credentials permanently unreadable.
 */
export const CREDENTIAL_PURPOSES = [
  "ai-provider-credential",
  "webhook-endpoint-secret",
] as const;

export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

export class CredentialEncryptionError extends Error {
  constructor(
    readonly code:
      | "ENCRYPTION_UNAVAILABLE"
      | "INVALID_LOCAL_KEY"
      | "KEY_MISMATCH"
      | "DECRYPTION_FAILED",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CredentialEncryptionError";
  }
}

/**
 * Which environment variables configure each purpose. Separate keys per purpose
 * are deliberate: a ciphertext minted for one purpose must not be decryptable
 * under another even if an operator reuses key material.
 */
const KEY_ENVIRONMENT: Record<
  CredentialPurpose,
  { readonly kms: string; readonly local: string }
> = {
  "ai-provider-credential": {
    kms: "AI_CREDENTIALS_KMS_KEY_ARN",
    local: "AI_CREDENTIALS_LOCAL_KEY",
  },
  "webhook-endpoint-secret": {
    kms: "WEBHOOK_SECRETS_KMS_KEY_ARN",
    local: "WEBHOOK_SECRETS_LOCAL_KEY",
  },
};

const LOCAL_SCHEME = "local:aes-256-gcm:";
const LOCAL_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * The KMS EncryptionContext, and the AES-GCM additional authenticated data, are
 * the same value: whichever scheme is in use, a ciphertext is bound to one
 * workspace and one purpose.
 */
export function credentialEncryptionContext(
  workspaceId: string,
  purpose: CredentialPurpose,
): Record<string, string> {
  return { application: "cap", workspaceId, purpose };
}

/** Stable serialization of the context, for use as AES-GCM AAD. */
function additionalData(
  workspaceId: string,
  purpose: CredentialPurpose,
): Buffer {
  const context = credentialEncryptionContext(workspaceId, purpose);
  return Buffer.from(
    Object.keys(context)
      .sort()
      .map((key) => `${key}=${context[key]}`)
      .join("&"),
    "utf8",
  );
}

/** Short, non-reversible identity of a secret, safe to show in an admin UI. */
export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(-12);
}

/**
 * Reads a key variable, treating blank as unset — `.env` templates ship these
 * declared and empty, so "" must mean "not configured" everywhere rather than
 * in some checks but not others.
 */
function configuredValue(variable: string): string | undefined {
  const value = process.env[variable]?.trim();
  return value ? value : undefined;
}

function localKey(purpose: CredentialPurpose): Buffer | undefined {
  const encoded = configuredValue(KEY_ENVIRONMENT[purpose].local);
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== LOCAL_KEY_BYTES)
    throw new CredentialEncryptionError(
      "INVALID_LOCAL_KEY",
      `${KEY_ENVIRONMENT[purpose].local} must be ${LOCAL_KEY_BYTES} base64-encoded bytes`,
    );
  return key;
}

function localKeyReference(key: Buffer): string {
  return `${LOCAL_SCHEME}${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function kmsClient(): KMSClient {
  return new KMSClient(
    process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {},
  );
}

/** True when this process can encrypt secrets for the given purpose. */
export function credentialEncryptionConfigured(
  purpose: CredentialPurpose,
): boolean {
  return Boolean(
    configuredValue(KEY_ENVIRONMENT[purpose].kms) ??
    configuredValue(KEY_ENVIRONMENT[purpose].local),
  );
}

export interface EncryptedCredential {
  readonly ciphertext: string;
  /**
   * Identifies the key that can decrypt this ciphertext: a KMS ARN, or
   * `local:aes-256-gcm:<key id>`. Persist it with the ciphertext — the reader
   * uses it to pick a scheme, which is what lets a deployment migrate schemes
   * without rewriting stored rows.
   */
  readonly keyReference: string;
  readonly fingerprint: string;
}

export async function encryptCredential(input: {
  readonly workspaceId: string;
  readonly purpose: CredentialPurpose;
  readonly secret: string;
  readonly kms?: KMSClient;
}): Promise<EncryptedCredential> {
  const keyArn = configuredValue(KEY_ENVIRONMENT[input.purpose].kms);
  const fingerprint = secretFingerprint(input.secret);

  if (keyArn) {
    const result = await (input.kms ?? kmsClient()).send(
      new EncryptCommand({
        KeyId: keyArn,
        Plaintext: Buffer.from(input.secret, "utf8"),
        EncryptionContext: credentialEncryptionContext(
          input.workspaceId,
          input.purpose,
        ),
      }),
    );
    if (!result.CiphertextBlob)
      throw new CredentialEncryptionError(
        "DECRYPTION_FAILED",
        "KMS returned no ciphertext",
      );
    return {
      ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
      keyReference: result.KeyId ?? keyArn,
      fingerprint,
    };
  }

  const key = localKey(input.purpose);
  if (!key)
    throw new CredentialEncryptionError(
      "ENCRYPTION_UNAVAILABLE",
      `Set ${KEY_ENVIRONMENT[input.purpose].kms} or ${KEY_ENVIRONMENT[input.purpose].local}`,
    );

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(input.workspaceId, input.purpose));
  const ciphertext = Buffer.concat([
    cipher.update(input.secret, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    ),
    keyReference: localKeyReference(key),
    fingerprint,
  };
}

export async function decryptCredential(input: {
  readonly workspaceId: string;
  readonly purpose: CredentialPurpose;
  readonly ciphertext: string;
  readonly keyReference: string;
  readonly kms?: KMSClient;
}): Promise<string> {
  if (!input.keyReference.startsWith(LOCAL_SCHEME)) {
    const result = await (input.kms ?? kmsClient()).send(
      new DecryptCommand({
        KeyId: input.keyReference,
        CiphertextBlob: Buffer.from(input.ciphertext, "base64"),
        EncryptionContext: credentialEncryptionContext(
          input.workspaceId,
          input.purpose,
        ),
      }),
    );
    if (!result.Plaintext)
      throw new CredentialEncryptionError(
        "DECRYPTION_FAILED",
        "KMS returned no plaintext",
      );
    return Buffer.from(result.Plaintext).toString("utf8");
  }

  const key = localKey(input.purpose);
  if (!key)
    throw new CredentialEncryptionError(
      "ENCRYPTION_UNAVAILABLE",
      `${KEY_ENVIRONMENT[input.purpose].local} is required to read this credential`,
    );
  // Refuse rather than fail obscurely when the configured key is not the one
  // this ciphertext was written with.
  if (localKeyReference(key) !== input.keyReference)
    throw new CredentialEncryptionError(
      "KEY_MISMATCH",
      "Stored credential was encrypted with a different local key",
    );

  const raw = Buffer.from(input.ciphertext, "base64");
  if (raw.byteLength <= GCM_IV_BYTES + GCM_TAG_BYTES)
    throw new CredentialEncryptionError(
      "DECRYPTION_FAILED",
      "Stored credential is truncated",
    );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    raw.subarray(0, GCM_IV_BYTES),
  );
  decipher.setAAD(additionalData(input.workspaceId, input.purpose));
  decipher.setAuthTag(raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A tag failure means the ciphertext, the workspace, or the purpose does not
    // match what was sealed. Never leak which.
    throw new CredentialEncryptionError("DECRYPTION_FAILED");
  }
}
