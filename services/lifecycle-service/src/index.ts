import { hostFromEnv, portFromEnv, startService } from "@vellar/service-kit";
import { createHorizonAccountReader } from "./horizon";
import { buildServer } from "./server";
import { initializeAuditLog } from "./audit";

const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const [, auditLog] = initializeAuditLog("memory");

// Optional job store for async cleanup (Issue #293)
let jobStore;
if (process.env.DATABASE_URL) {
  const { connectDb } = await import("./db/client");
  const { createPgCleanupJobStore } = await import("./db/pg-job-store");
  try {
    const db = await connectDb(process.env.DATABASE_URL);
    jobStore = createPgCleanupJobStore(db);
  } catch (err) {
    console.warn("Failed to connect to database; running in synchronous-only mode:", err);
  }
}

const app = buildServer({
  reader: createHorizonAccountReader(horizonUrl),
  store: jobStore,
});
await startService(app, {
  port: portFromEnv("LIFECYCLE_SERVICE_PORT", 4002),
  host: hostFromEnv("127.0.0.1"),
});
