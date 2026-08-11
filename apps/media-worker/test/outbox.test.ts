import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import {
  mediaProcessingJobOptions,
  type MediaProcessingJob,
} from "@cap/queue";
import { dispatchProcessingOutbox } from "../src/outbox";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function fakePool(client: FakeClient): Pool {
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

function fakeQueue(): Queue<MediaProcessingJob> {
  return { add: vi.fn() } as unknown as Queue<MediaProcessingJob>;
}

const validPayload = {
  recordingId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sourceObjectKey: "recordings/11111111-1111-4111-8111-111111111111/source.mp4",
  processingVersion: 1,
};

describe("dispatchProcessingOutbox", () => {
  it("publishes a job for each unpublished row and marks it published", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM processing_outbox")) {
        return {
          rows: [{ id: "outbox-1", payload: validPayload }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE processing_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    const count = await dispatchProcessingOutbox(pool, queue, 25);

    expect(count).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "process-recording",
      validPayload,
      mediaProcessingJobOptions(
        validPayload.recordingId,
        validPayload.processingVersion,
      ),
    );

    const updateCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("UPDATE processing_outbox"),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.[1]).toEqual(["outbox-1"]);

    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns zero and enqueues nothing when there are no unpublished rows", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM processing_outbox")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    const count = await dispatchProcessingOutbox(pool, queue);

    expect(count).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();

    const updateCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("UPDATE processing_outbox"),
    );
    expect(updateCalls).toHaveLength(0);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
  });

  it("rolls back and rethrows when a query fails", async () => {
    const failure = new Error("connection reset");
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("FROM processing_outbox")) throw failure;
      if (sql === "ROLLBACK") return {};
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    await expect(dispatchProcessingOutbox(pool, queue)).rejects.toThrow(
      failure,
    );

    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
