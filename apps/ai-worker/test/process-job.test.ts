import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type { KMSClient } from "@aws-sdk/client-kms";
import type { AiJob } from "@cap/queue";
import { providerForJob, processJob } from "../src/process-job";

function fakePool(queryImpl: (...args: unknown[]) => unknown) {
  return {
    query: vi.fn(queryImpl),
    connect: vi.fn(),
  } as unknown as Pool;
}

function baseJobData(overrides: Partial<AiJob> = {}): AiJob {
  return {
    jobId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    recordingId: "33333333-3333-3333-3333-333333333333",
    transcriptId: "44444444-4444-4444-4444-444444444444",
    transcriptRevision: 1,
    capability: "SUMMARY",
    requestedBy: "55555555-5555-5555-5555-555555555555",
    ...overrides,
  };
}

describe("providerForJob", () => {
  const originalAllowDeploymentCredential =
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
  const originalApiKey = process.env.AI_API_KEY;

  afterEach(() => {
    if (originalAllowDeploymentCredential === undefined)
      delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    else
      process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL =
        originalAllowDeploymentCredential;
    if (originalApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalApiKey;
  });

  it("throws when no matching job/connection row exists", async () => {
    const pool = fakePool(() => ({ rows: [], rowCount: 0 }));
    const kms = { send: vi.fn() } as unknown as KMSClient;
    await expect(providerForJob(pool, kms, baseJobData())).rejects.toThrow(
      "AI job is not available",
    );
  });

  it("throws when connection is missing and deployment credential fallback is disallowed", async () => {
    delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    const pool = fakePool(() => ({
      rows: [
        {
          provider_connection_id: null,
          model: null,
          provider: null,
          base_url: null,
          encrypted_credential: null,
          credential_key_arn: null,
        },
      ],
      rowCount: 1,
    }));
    const kms = { send: vi.fn() } as unknown as KMSClient;
    await expect(providerForJob(pool, kms, baseJobData())).rejects.toThrow(
      "AI provider connection is required",
    );
  });

  it("falls back to providerFromEnvironment when AI_ALLOW_DEPLOYMENT_CREDENTIAL is 'true'", async () => {
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = "true";
    process.env.AI_API_KEY = "env-api-key";
    const pool = fakePool(() => ({
      rows: [
        {
          provider_connection_id: null,
          model: null,
          provider: null,
          base_url: null,
          encrypted_credential: null,
          credential_key_arn: null,
        },
      ],
      rowCount: 1,
    }));
    const kms = { send: vi.fn() } as unknown as KMSClient;
    const provider = await providerForJob(pool, kms, baseJobData());
    expect(provider.name).toBe("OPENAI");
    expect(kms.send).not.toHaveBeenCalled();
  });

  it("throws when the connection row is missing required credential fields", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          provider_connection_id: "conn-1",
          model: null,
          provider: "ANTHROPIC",
          base_url: null,
          encrypted_credential: "ciphertext",
          credential_key_arn: "arn:aws:kms:key",
        },
      ],
      rowCount: 1,
    }));
    const kms = { send: vi.fn() } as unknown as KMSClient;
    await expect(providerForJob(pool, kms, baseJobData())).rejects.toThrow(
      "AI provider connection is unavailable",
    );
  });

  it("decrypts the credential via KMS and builds the provider from the connection on the happy path", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          provider_connection_id: "conn-1",
          model: "claude-x",
          provider: "ANTHROPIC",
          base_url: "https://custom.example.com",
          encrypted_credential: Buffer.from("ciphertext").toString("base64"),
          credential_key_arn: "arn:aws:kms:key",
        },
      ],
      rowCount: 1,
    }));
    const kms = {
      send: vi.fn(async () => ({
        Plaintext: Buffer.from("decrypted-secret"),
      })),
    } as unknown as KMSClient;
    const data = baseJobData();
    const provider = await providerForJob(pool, kms, data);
    expect(provider.name).toBe("ANTHROPIC");
    expect(kms.send).toHaveBeenCalledTimes(1);
    const command = (kms.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(command.input).toMatchObject({
      KeyId: "arn:aws:kms:key",
      CiphertextBlob: Buffer.from("ciphertext"),
      EncryptionContext: {
        application: "cap",
        workspaceId: data.workspaceId,
        purpose: "ai-provider-credential",
      },
    });
    const config = (provider as unknown as { c: Record<string, unknown> }).c;
    expect(config).toMatchObject({
      baseUrl: "https://custom.example.com",
      apiKey: "decrypted-secret",
      model: "claude-x",
    });
  });
});

describe("processJob", () => {
  const originalAllowDeploymentCredential =
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
  const originalApiKey = process.env.AI_API_KEY;

  beforeEach(() => {
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = "true";
    process.env.AI_API_KEY = "env-api-key";
  });

  afterEach(() => {
    if (originalAllowDeploymentCredential === undefined)
      delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    else
      process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL =
        originalAllowDeploymentCredential;
    if (originalApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalApiKey;
  });

  function jobFor(data: AiJob): Job<AiJob> {
    return { data } as unknown as Job<AiJob>;
  }

  const deploymentFallbackRow = {
    provider_connection_id: null,
    model: null,
    provider: null,
    base_url: null,
    encrypted_credential: null,
    credential_key_arn: null,
  };

  it("marks the job FAILED with error_category='PolicyDenied' and stops when the workspace policy disallows external processing", async () => {
    const calls: unknown[][] = [];
    const pool = fakePool((sql: unknown, params?: unknown) => {
      calls.push([sql, params]);
      const call = calls.length;
      if (call === 1) return { rows: [deploymentFallbackRow], rowCount: 1 };
      if (call === 2)
        return {
          rows: [
            {
              enabled: false,
              allowed_provider: "OPENAI",
              allow_external_processing: false,
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 1 };
    });
    const kms = { send: vi.fn() } as unknown as KMSClient;
    const data = baseJobData();
    await processJob(pool, kms, jobFor(data));
    expect(calls).toHaveLength(3);
    const [thirdSql, thirdParams] = calls[2]!;
    expect(String(thirdSql)).toContain("status='FAILED'");
    expect(String(thirdSql)).toContain("error_category='PolicyDenied'");
    expect(thirdParams).toEqual([data.jobId, data.workspaceId]);
    expect(pool.connect as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails the job when the transcript changed after the job was authorized", async () => {
    const calls: unknown[][] = [];
    const pool = fakePool((sql: unknown, params?: unknown) => {
      calls.push([sql, params]);
      const call = calls.length;
      if (call === 1) return { rows: [deploymentFallbackRow], rowCount: 1 };
      if (call === 2)
        return {
          rows: [
            {
              enabled: true,
              allowed_provider: "OPENAI",
              allow_external_processing: true,
            },
          ],
          rowCount: 1,
        };
      if (call === 3)
        return { rows: [{ input_hash: "stale-hash" }], rowCount: 1 };
      if (call === 4)
        return {
          rows: [{ text: "hello world", revision: 1 }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 1 };
    });
    const kms = { send: vi.fn() } as unknown as KMSClient;
    const data = baseJobData({ transcriptRevision: 1 });
    await expect(processJob(pool, kms, jobFor(data))).rejects.toThrow(
      "Transcript changed after AI job was authorized",
    );
    expect(calls).toHaveLength(5);
    const [failSql, failParams] = calls[4]!;
    expect(String(failSql)).toContain("status='FAILED'");
    expect(failParams).toEqual([data.jobId, "Error"]);
  });

  it("returns without proceeding when the job could not be claimed", async () => {
    const calls: unknown[][] = [];
    const pool = fakePool((sql: unknown, params?: unknown) => {
      calls.push([sql, params]);
      const call = calls.length;
      if (call === 1) return { rows: [deploymentFallbackRow], rowCount: 1 };
      if (call === 2)
        return {
          rows: [
            {
              enabled: true,
              allowed_provider: "OPENAI",
              allow_external_processing: true,
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const kms = { send: vi.fn() } as unknown as KMSClient;
    const data = baseJobData();
    await processJob(pool, kms, jobFor(data));
    expect(calls).toHaveLength(3);
  });
});
