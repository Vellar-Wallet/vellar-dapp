import pg from "pg";
import { portFromEnv, startService } from "@vellar/service-kit";
import { buildPermissionServer } from "./server";

export { configFromEnv, DEFAULTS, type PermissionServiceRuntimeConfig } from "./config";
export { OriginPermissionCache } from "./origin-permission-cache";
export { buildPermissionServer, type PermissionServiceDeps } from "./server";

const databaseUrl = process.env.DATABASE_URL;
let dbCheck: (() => Promise<boolean>) | undefined;

if (databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  dbCheck = async () => {
    try {
      const client = await pool.connect();
      client.release();
      return true;
    } catch {
      return false;
    }
  };
}

const server = buildPermissionServer({ dbCheck });

if (process.env.NODE_ENV !== "test") {
  const port = portFromEnv("PERMISSION_SERVICE_PORT", 4006);
  await startService(server, { port });
}
