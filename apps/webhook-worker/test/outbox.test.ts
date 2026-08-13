import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { webhookDeliveryJobOptions, type WebhookDeliveryJob } from "@cap/queue";
import { dispatchWebhookOutbox } from "../src/outbox";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function fakePool(client: FakeClient): Pool {
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

function fakeQueue(): Queue<WebhookDeliveryJob> {
  return { add: vi.fn() } as unknown as Queue<WebhookDeliveryJob>;
}

describe("dispatchWebhookOutbox", () => {
  it("fans an outbox row out to every matching active endpoint", async () => {
    let deliverySeq = 0;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM webhook_outbox")) {
        return {
          rows: [
            {
              id: "outbox-1",
              event: "recording.completed",
              workspace_id: "workspace-1",
              payload: { recordingId: "rec-1" },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM webhook_endpoints")) {
        return {
          rows: [{ id: "endpoint-1" }, { id: "endpoint-2" }],
          rowCount: 2,
        };
      }
      if (sql.includes("INSERT INTO webhook_deliveries")) {
        deliverySeq += 1;
        return { rows: [{ id: `delivery-${deliverySeq}` }], rowCount: 1 };
      }
      if (sql.includes("UPDATE webhook_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    const count = await dispatchWebhookOutbox(pool, queue, 50);

    expect(count).toBe(1);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      "deliver",
      { deliveryId: "delivery-1" },
      webhookDeliveryJobOptions("delivery-1"),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "deliver",
      { deliveryId: "delivery-2" },
      webhookDeliveryJobOptions("delivery-2"),
    );

    const insertCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO webhook_deliveries"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]?.[1]).toEqual([
      "endpoint-1",
      "workspace-1",
      "recording.completed",
      JSON.stringify({ recordingId: "rec-1" }),
    ]);
    expect(insertCalls[1]?.[1]).toEqual([
      "endpoint-2",
      "workspace-1",
      "recording.completed",
      JSON.stringify({ recordingId: "rec-1" }),
    ]);

    const updateCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("UPDATE webhook_outbox"),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.[1]).toEqual(["outbox-1"]);

    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("marks a row with no matching endpoints as published without enqueueing anything", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM webhook_outbox")) {
        return {
          rows: [
            {
              id: "outbox-2",
              event: "recording.completed",
              workspace_id: "workspace-1",
              payload: {},
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM webhook_endpoints"))
        return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE webhook_outbox"))
        return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    const count = await dispatchWebhookOutbox(pool, queue);

    expect(count).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();

    const insertCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO webhook_deliveries"),
    );
    expect(insertCalls).toHaveLength(0);

    const updateCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("UPDATE webhook_outbox"),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.[1]).toEqual(["outbox-2"]);

    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
  });

  it("rolls back and rethrows when a query fails", async () => {
    const failure = new Error("connection reset");
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === "BEGIN") return {};
      if (sql.includes("FROM webhook_outbox")) throw failure;
      if (sql === "ROLLBACK") return {};
      throw new Error(`unexpected query: ${sql}`);
    });
    const client: FakeClient = { query, release: vi.fn() };
    const pool = fakePool(client);
    const queue = fakeQueue();

    await expect(dispatchWebhookOutbox(pool, queue)).rejects.toThrow(failure);

    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
