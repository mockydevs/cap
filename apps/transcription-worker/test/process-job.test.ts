import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import type {
  TranscriptionProvider,
  TranscriptPersistence,
} from "@cap/transcription";
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

function fakePool(queryImpl: (...args: unknown[]) => unknown) {
  return { query: vi.fn(queryImpl) } as unknown as Pool;
}

function fakeProvider(): TranscriptionProvider {
  return {
    name: "local-test",
    transcribe: vi.fn(),
  } as unknown as TranscriptionProvider;
}

function fakePersistence(): TranscriptPersistence {
  return {
    loadCanonical: vi.fn(),
    commitMergedProviderRun: vi.fn(),
    applySegmentCorrection: vi.fn(),
  } as unknown as TranscriptPersistence;
}

function jobFor(data: TranscriptionJob): Job<TranscriptionJob> {
  return { id: "job-1", data } as unknown as Job<TranscriptionJob>;
}

function baseJobData(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    recordingId: "33333333-3333-3333-3333-333333333333",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    processingVersion: 1,
    sourceObjectKey: "recordings/source.mp4",
    ...overrides,
  };
}

describe("processJob", () => {
  const envKeys = [
    "TRANSCRIPTION_CONSENT_BASIS",
    "TRANSCRIPTION_CONSENT_ACTOR_USER_ID",
    "AWS_S3_BUCKET_NAME",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) originalEnv[key] = process.env[key];
    s3Send.mockReset();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("throws when the recording has no playback asset for transcription", async () => {
    const pool = fakePool(() => ({ rows: [], rowCount: 0 }));
    await expect(
      processJob(
        pool,
        fakeProvider(),
        fakePersistence(),
        jobFor(baseJobData()),
      ),
    ).rejects.toThrow("Recording has no playback asset for transcription");
  });

  it("throws when TRANSCRIPTION_CONSENT_BASIS is missing", async () => {
    delete process.env.TRANSCRIPTION_CONSENT_BASIS;
    const pool = fakePool(() => ({
      rows: [{ transcript_id: "transcript-1", attempt: 1 }],
      rowCount: 1,
    }));
    await expect(
      processJob(
        pool,
        fakeProvider(),
        fakePersistence(),
        jobFor(baseJobData()),
      ),
    ).rejects.toThrow("TRANSCRIPTION_CONSENT_BASIS must be configured");
  });

  it("throws when TRANSCRIPTION_CONSENT_BASIS is not a recognized value", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "BOGUS";
    const pool = fakePool(() => ({
      rows: [{ transcript_id: "transcript-1", attempt: 1 }],
      rowCount: 1,
    }));
    await expect(
      processJob(
        pool,
        fakeProvider(),
        fakePersistence(),
        jobFor(baseJobData()),
      ),
    ).rejects.toThrow("TRANSCRIPTION_CONSENT_BASIS is invalid");
  });

  it("throws when EXPLICIT consent is chosen without an actor", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "EXPLICIT";
    delete process.env.TRANSCRIPTION_CONSENT_ACTOR_USER_ID;
    const pool = fakePool(() => ({
      rows: [{ transcript_id: "transcript-1", attempt: 1 }],
      rowCount: 1,
    }));
    await expect(
      processJob(
        pool,
        fakeProvider(),
        fakePersistence(),
        jobFor(baseJobData()),
      ),
    ).rejects.toThrow(
      "Explicit consent requires TRANSCRIPTION_CONSENT_ACTOR_USER_ID",
    );
  });

  it("inserts a FAILED transcription_runs row and marks the transcript FAILED when the pipeline fails", async () => {
    process.env.TRANSCRIPTION_CONSENT_BASIS = "NOT_REQUIRED";
    delete process.env.TRANSCRIPTION_CONSENT_ACTOR_USER_ID;
    process.env.AWS_S3_BUCKET_NAME = "test-bucket";
    s3Send.mockRejectedValueOnce(new Error("S3 unavailable"));

    const calls: unknown[][] = [];
    const pool = fakePool((sql: unknown, params?: unknown) => {
      calls.push([sql, params]);
      const call = calls.length;
      if (call === 1)
        return {
          rows: [{ transcript_id: "transcript-1", attempt: 1 }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 1 };
    });
    const provider = fakeProvider();
    const persistence = fakePersistence();

    await expect(
      processJob(pool, provider, persistence, jobFor(baseJobData())),
    ).rejects.toThrow("S3 unavailable");

    expect(calls).toHaveLength(3);
    const [runSql, runParams] = calls[1]!;
    expect(String(runSql)).toContain("INSERT INTO transcription_runs");
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
    const [transcriptSql, transcriptParams] = calls[2]!;
    expect(String(transcriptSql)).toContain(
      "UPDATE transcripts SET status='FAILED'",
    );
    expect(transcriptParams).toEqual(["transcript-1"]);
    expect(persistence.commitMergedProviderRun).not.toHaveBeenCalled();
  });
});
