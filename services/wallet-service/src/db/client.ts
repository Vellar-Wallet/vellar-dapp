import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export type Db = NodePgDatabase;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

/** Connects and applies pending migrations (idempotent) before returning. */
export async function connectDb(databaseUrl: string): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  return {
    db,
    close: () => pool.end(),
  };
}
