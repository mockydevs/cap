import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

/**
 * Identifies Cap's schema migration across every connection to this database.
 * Any constant works as long as it never changes.
 */
const MIGRATION_LOCK_KEY = 4_213_705_001;

// Resolved from the entry script rather than the working directory, so the same
// code serves the repo checkout (apps/web/scripts/migrate.mjs) and the image
// (/app/scripts/migrate.cjs). `import.meta.url` cannot be used here: esbuild
// stubs it to an empty object when it bundles this file to CommonJS.
const migrationsFolder = resolve(dirname(process.argv[1]), "../db/migrations");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL must be configured before migrations can run",
    );
  }

  // Every container migrates on start, so starts must serialize. Drizzle's
  // migrator takes no lock of its own: concurrent runners each read the same
  // last-applied row and then replay the same non-idempotent DDL, and the
  // losers crash. A session lock is released even if this process dies.
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(pool), { migrationsFolder });
      console.log("Database migrations completed");
    } finally {
      await pool.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
