import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL must be configured before migrations can run",
    );
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "/app/db/migrations" });
    console.log("Database migrations completed");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
