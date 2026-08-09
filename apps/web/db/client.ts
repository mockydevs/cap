import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let database: NodePgDatabase<typeof schema> | undefined;

export function db() {
  if (!database) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be configured");
    database = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema });
  }
  return database;
}
