import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { Pool, PoolClient } from "pg";
import type { KMSClient } from "@aws-sdk/client-kms";
import type { TranscriptPersistence } from "@cap/transcription";
import type { TranscriptionJob } from "@cap/queue";

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
    constructor(_config: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { processJob } = await import("../src/process-job");

interface WorkspaceState {
  policy?: Record<string, unknown> | null;
  route?: { connection_id: string; model: string } | null;
  usage?: { tokens: string; cost: string };
  subscription?: Record<string, unknown> | null;
}

/**
 * Answers the entitlement loader by statement shape, then defers anything else
 * to the per-test handler, so each test describes a workspace rather than a
 * sequence of queries.
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
        return { rows: state.route ? [state.route] : [] };
      if (sql.includes("FROM workspace_subscriptions"))
        return { rows: state.subscription ? [state.subscription] : [] };
      if (sql.includes("FROM ai_usage_events"))
        return { rows: [state.usage ?? { tokens: "0", cost: "0" }] };
      return extra?.(sql, params) ?? { rows: [], rowCount: 1 };
    }),
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

const kmsStub = () => ({ send: vi.fn() }) as unknown as KMSClient;

function fakePersistence(): TranscriptPersistence<PoolClient> {
  return {
    loadCanonical: vi.fn(),
    commitMergedProviderRun: vi.fn(),
    applySegmentCorrection: vi.fn(),
  } as unknown as TranscriptPersistence<PoolClient>;
}

function jobFor(data: TranscriptionJob): Job<TranscriptionJob> {
  return { id: "job-1", data } as unknown as Job<TranscriptionJob>;
}

function baseJobData(
  overrides: Partial<TranscriptionJob> = {},
): TranscriptionJob {
  return {
    recordingId: "33333333-3333-3333-3333-333333333333",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    processingVersion: 1,
    sourceObjectKey: "recordings/source.mp4",
    ...overrides,
  };
}

/** Transcript row lookup, once the workspace is entitled. */
const transcriptRow = (sql: string) =>
  sql.includes("INSERT INTO transcripts")
    ? { rows: [{ transcript_id: "transcript-1", attempt: 1 }], rowCount: 1 }
    : undefined;

describe("processJob", () => {
  const envKeys = [
    "TRANSCRIPTION_CONSENT_BASIS",
    "TRANSCRIPTION_CONSENT_ACTOR_USER_ID",
    "TRANSCRIPTION_PROVIDER",
    "AI_ALLOW_DEPLOYMENT_CREDENTIAL",
    "AWS_S3_BUCKET_NAME",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) originalEnv[key] = process.env[key];
    process.env.TRANSCRIPTION_PROVIDER = "local-test";
    process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL = "true";
    s3Send.mockReset();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("disables the transcript and spends nothing when the workspace has no way to pay", async () => {
    delete process.env.AI_ALLOW_DEPLOYMENT_CREDENTIAL;
    const persistence = fakePersistence();
    const { pool, calls } = workspacePool({ policy: enabledPolicy });
    await processJob(pool, kmsStub(), persistence, jobFor(baseJobData()));
    const disabled = calls.find(([sql]) => sql.includes("'DISABLED'"));
    expect(disabled).toBeDefined();
    expect(s3Send).not.toHaveBeenCalled();
    expect(persistence.loadCanonical).not.toHaveBeenCalled();
    expect(calls.some(([sql]) => sql.includes("status='PROCESSING'"))).toBe(
      false,
    );
  });

  it("disables the transcript when AI is switched off entirely", async () => {
    const { pool, calls } = workspacePool({ policy: null });
    await processJob(pool, kmsStub(), fakePersistence(), jobFor(baseJobData()));
    expect(calls.some(([sql]) => sql.includes("'DISABLED'"))).toBe(true);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("throws when the recording has no playback asset for transcription", async () => {
    const { pool } = workspacePool({ policy: enabledPolicy }, (sql) =>
      sql.includes("INSERT INTO transcripts")
        ? { rows: [], rowCount: 0 }
        : undefined,
    );
    await expect(
      processJob(pool, kmsStub(), fakePersistence(), jobFor(baseJobData())),
    ).rejects.toThrow("Recording has no playback asset for transcription");
  });

  it("throws when TRANSCRIPTION_CONSENT_BASIS is missing", async () => {
    delete process.env.TRANSCRIPTION_CONSENT_BASIS;
    const { pool } = workspacePool({ policy: enabledPolicy }, transcriptRow);
    await expect(
      processJob(pool, kmsStub(), fakePersistence(), jobFor(baseJobData())),
    ).rejects.toThrow("TRANSCRIPTION_CONSENT_BASIS must be configured");
  });

  it("throws when TRANSCRIPTION_CONSENT_BASIS is not a recognized value", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "BOGUS";
    const { pool } = workspacePool({ policy: enabledPolicy }, transcriptRow);
    await expect(
      processJob(pool, kmsStub(), fakePersistence(), jobFor(baseJobData())),
    ).rejects.toThrow("TRANSCRIPTION_CONSENT_BASIS is invalid");
  });

  it("throws when EXPLICIT consent is chosen without an actor", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "EXPLICIT";
    delete process.env.TRANSCRIPTION_CONSENT_ACTOR_USER_ID;
    const { pool } = workspacePool({ policy: enabledPolicy }, transcriptRow);
    await expect(
      processJob(pool, kmsStub(), fakePersistence(), jobFor(baseJobData())),
    ).rejects.toThrow(
      "Explicit consent requires TRANSCRIPTION_CONSENT_ACTOR_USER_ID",
    );
  });

  it("inserts a FAILED transcription_runs row and marks the transcript FAILED when the pipeline fails", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "NOT_REQUIRED";
    delete process.env.TRANSCRIPTION_CONSENT_ACTOR_USER_ID;
    process.env.AWS_S3_BUCKET_NAME = "test-bucket";
    s3Send.mockRejectedValueOnce(new Error("S3 unavailable"));

    const persistence = fakePersistence();
    const { pool, calls } = workspacePool(
      { policy: enabledPolicy },
      transcriptRow,
    );

    await expect(
      processJob(pool, kmsStub(), persistence, jobFor(baseJobData())),
    ).rejects.toThrow("S3 unavailable");

    const [runSql, runParams] = calls.find(([sql]) =>
      sql.includes("INSERT INTO transcription_runs"),
    )!;
    expect(String(runSql)).toContain("'FAILED'");
    expect(runParams).toMatchObject([
      expect.any(String),
      "transcript-1",
      1,
      "local-test",
      "unknown",
      "NOT_REQUIRED",
      expect.any(Date),
      null,
      "Error",
    ]);
    const [, transcriptParams] = calls.find(([sql]) =>
      sql.includes("UPDATE transcripts SET status='FAILED'"),
    )!;
    expect(transcriptParams).toEqual(["transcript-1"]);
    expect(persistence.commitMergedProviderRun).not.toHaveBeenCalled();
  });
});
