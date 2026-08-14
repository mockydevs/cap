import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../src/index";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function fakeClient(
  query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
): FakeClient {
  return { query, release: vi.fn() };
}

function fakePool(client: FakeClient): Pool {
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

describe("withTransaction", () => {
  it("wraps the work in BEGIN and COMMIT and returns its result", async () => {
    const client = fakeClient();
    const pool = fakePool(client);

    const result = await withTransaction(pool, async (transaction) => {
      await transaction.query("INSERT INTO recordings DEFAULT VALUES");
      return "done";
    });

    expect(result).toBe("done");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "INSERT INTO recordings DEFAULT VALUES",
      "COMMIT",
    ]);
  });

  it("runs every statement on the one checked-out connection", async () => {
    const client = fakeClient();
    const pool = fakePool(client);
    const seen: PoolClient[] = [];

    await withTransaction(pool, async (transaction) => {
      seen.push(transaction);
      await transaction.query("SELECT 1");
      seen.push(transaction);
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(client as unknown as PoolClient);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const client = fakeClient();
    const pool = fakePool(client);
    const failure = new Error("constraint violated");

    await expect(
      withTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
  });

  it("releases the connection whether the work succeeds or fails", async () => {
    const committed = fakeClient();
    await withTransaction(fakePool(committed), async () => undefined);
    expect(committed.release).toHaveBeenCalledTimes(1);

    const rolledBack = fakeClient();
    await expect(
      withTransaction(fakePool(rolledBack), async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(rolledBack.release).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original failure when the rollback itself fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("connection already closed");
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      throw new Error("original failure");
    });
    const client = fakeClient(query);

    await expect(
      withTransaction(fakePool(client), (transaction) =>
        transaction.query("UPDATE recordings SET status = 'READY'"),
      ),
    ).rejects.toThrow("original failure");

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
