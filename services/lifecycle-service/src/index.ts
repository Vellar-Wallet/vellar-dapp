import { hostFromEnv, portFromEnv, startService } from "@vellar/service-kit";
import { createCachedAccountReader } from "./account-cache";
import { createHorizonAccountReader } from "./horizon";
import { buildServer } from "./server";
import { initializeAuditLog } from "./audit";

const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const [, auditLog] = initializeAuditLog("memory");

const app = buildServer({
  reader: createCachedAccountReader(createHorizonAccountReader(horizonUrl)),
  audit: auditLog,
});
await startService(app, {
  port: portFromEnv("LIFECYCLE_SERVICE_PORT", 4002),
  host: hostFromEnv("127.0.0.1"),
});
