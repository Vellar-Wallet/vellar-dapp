import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function connectDb(connectionString: string): Promise<NodePgDatabase> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const db = drizzle(client);
  
  // Run migrations from the migrations directory
  const migrationsFolder = path.join(__dirname, "migrations");
  await migrate(db, { migrationsFolder });
  
  return db;
}
