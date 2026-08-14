import type { Pool, PoolClient } from "pg";

/**
 * Runs `work` inside a single database transaction.
 *
 * The connection is checked out for the whole transaction. Issuing `BEGIN`
 * through `pool.query` instead hands each statement an arbitrary idle
 * connection, so the statements, the commit, and the rollback can land on
 * different sessions — the transaction silently stops being atomic as soon as
 * a caller runs more than one job at a time.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // A failed rollback means the connection is already unusable; surface the
      // original error rather than this one.
    });
    throw error;
  } finally {
    client.release();
  }
}
