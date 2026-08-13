import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type { KMSClient } from "@aws-sdk/client-kms";
import type { AiJob } from "@cap/queue";
import {
  AiEntitlementDenied,
  providerForJob,
  processJob,
} from "../src/process-job";

interface WorkspaceState {
  policy?: Record<string, unknown> | null;
  route?: { connection_id: string; model: string } | null;
  connection?: Record<string, unknown> | null;
  usage?: { tokens: string; cost: string };
  subscription?: Record<string, unknown> | null;
}

/**
 * Answers the entitlement loader's statements by shape rather than by call
 * order, so a test states the workspace it means instead of a query script.
 */
function workspacePool(
  state: WorkspaceState,
  extra?: (sql: string, params?: unknown) => unknown,
) {
  const calls: Array<[string, unknown]> = [];
  const pool = {
    query: vi.fn((sql: string, params?: unknown) => {
      calls.push([sql, params]);
      if (sql.includes("FROM ai_workspace_policies"))
        return {
          rows: state.policy === null ? [] : [state.policy],
          rowCount: state.policy === null ? 0 : 1,
        };
      if (sql.includes("FROM ai_provider_routes"))
        return { rows: state.route ? [state.route] : [], rowCount: 1 };
      if (sql.includes("FROM workspace_subscriptions"))
        return { rows: state.subscription ? [state.subscription] : [] };
      if (sql.includes("FROM ai_usage_events"))
        return { rows: [state.usage ?? { tokens: "0", cost: "0" }] };
      if (sql.includes("FROM ai_provider_connections"))
        return { rows: state.connection ? [state.connection] : [] };
      return extra?.(sql, params) ?? { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(),
  } as unknown as Pool;
  return { pool, calls };
}

const enabledPolicy = {
  enabled: true,
  allowed_provider: "openai-compatible",
  allow_external_processing: true,
  monthly_token_limit: 1_000_000,
  monthly_cost_limit_microunits: "25000000",
};

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

const kmsStub = () => ({ send: vi.fn() }) as unknown as KMSClient;

describe("providerForJob", () => {
  const original = {
    allow: process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL,
    key: process.env.AI_API_KEY,
  };

  afterEach(() => {
    if (original.allow === undefined)
      delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    else process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = original.allow;
    if (original.key === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = original.key;
  });

  it("denies a workspace that has not enabled AI", async () => {
    const { pool } = workspacePool({ policy: null });
    await expect(
      providerForJob(pool, kmsStub(), baseJobData()),
    ).rejects.toThrow(AiEntitlementDenied);
  });

  it("denies when no credential is routed and the deployment credential is not allowed", async () => {
    delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    const { pool } = workspacePool({ policy: enabledPolicy });
    await expect(
      providerForJob(pool, kmsStub(), baseJobData()),
    ).rejects.toMatchObject({ reason: "AI_PROVIDER_NOT_CONFIGURED" });
  });

  it("denies once the workspace ceiling is spent, before reaching a provider", async () => {
    const { pool } = workspacePool({
      policy: enabledPolicy,
      route: { connection_id: "conn-1", model: "gpt-5-mini" },
      usage: { tokens: "0", cost: "25000000" },
    });
    await expect(
      providerForJob(pool, kmsStub(), baseJobData()),
    ).rejects.toMatchObject({ reason: "AI_QUOTA_EXCEEDED" });
  });

  it("uses the deployment credential only when the operator opted in", async () => {
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = "true";
    process.env.AI_API_KEY = "env-api-key";
    const { pool } = workspacePool({ policy: enabledPolicy });
    const kms = kmsStub();
    const resolved = await providerForJob(pool, kms, baseJobData());
    expect(resolved.provider.name).toBe("OPENAI");
    expect(resolved.lane).toBe("DEPLOYMENT");
    expect(resolved.connectionId).toBeNull();
    expect(kms.send).not.toHaveBeenCalled();
  });

  it("denies when the routed connection has been revoked since enqueue", async () => {
    delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    const { pool } = workspacePool({
      policy: enabledPolicy,
      route: { connection_id: "conn-1", model: "claude-opus-5" },
      connection: null,
    });
    await expect(
      providerForJob(pool, kmsStub(), baseJobData()),
    ).rejects.toMatchObject({ reason: "AI_PROVIDER_NOT_CONFIGURED" });
  });

  it("decrypts the workspace credential and builds the provider from the connection", async () => {
    delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    const { pool } = workspacePool({
      policy: enabledPolicy,
      route: { connection_id: "conn-1", model: "claude-opus-5" },
      connection: {
        provider: "ANTHROPIC",
        base_url: "https://custom.example.com",
        encrypted_credential: Buffer.from("ciphertext").toString("base64"),
        credential_key_arn: "arn:aws:kms:key",
      },
    });
    const kms = {
      send: vi.fn(async () => ({ Plaintext: Buffer.from("decrypted-secret") })),
    } as unknown as KMSClient;
    const data = baseJobData();
    const resolved = await providerForJob(pool, kms, data);
    expect(resolved.provider.name).toBe("ANTHROPIC");
    expect(resolved.lane).toBe("BYOK");
    expect(resolved.connectionId).toBe("conn-1");
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
    const config = (
      resolved.provider as unknown as { c: Record<string, unknown> }
    ).c;
    expect(config).toMatchObject({
      baseUrl: "https://custom.example.com",
      apiKey: "decrypted-secret",
      model: "claude-opus-5",
    });
  });
});

describe("processJob", () => {
  const original = {
    allow: process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL,
    key: process.env.AI_API_KEY,
  };

  beforeEach(() => {
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = "true";
    process.env.AI_API_KEY = "env-api-key";
  });

  afterEach(() => {
    if (original.allow === undefined)
      delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    else process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = original.allow;
    if (original.key === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = original.key;
  });

  const jobFor = (data: AiJob) => ({ data }) as unknown as Job<AiJob>;

  it("records the denial reason and does not claim the job when the workspace withdrew consent", async () => {
    const { pool, calls } = workspacePool({
      policy: { ...enabledPolicy, allow_external_processing: false },
    });
    await processJob(pool, kmsStub(), jobFor(baseJobData()));
    const update = calls.find(([sql]) => sql.startsWith("UPDATE ai_jobs"));
    expect(update?.[0]).toContain("status='FAILED'");
    expect(update?.[1]).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "EXTERNAL_AI_DISABLED",
    ]);
    expect(calls.some(([sql]) => sql.includes("status='PROCESSING'"))).toBe(
      false,
    );
  });

  it("stops without generating when another worker already claimed the job", async () => {
    const { pool, calls } = workspacePool({ policy: enabledPolicy }, (sql) =>
      sql.startsWith("UPDATE ai_jobs") ? { rows: [], rowCount: 0 } : undefined,
    );
    await processJob(pool, kmsStub(), jobFor(baseJobData()));
    expect(calls.some(([sql]) => sql.includes("FROM transcripts"))).toBe(false);
  });
});
