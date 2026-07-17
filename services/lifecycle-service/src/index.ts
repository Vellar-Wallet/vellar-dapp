import { portFromEnv, startService } from "@vela/service-kit";
import { createHorizonAccountReader } from "./horizon";
import { buildServer } from "./server";

const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";

const app = buildServer({ reader: createHorizonAccountReader(horizonUrl) });
await startService(app, { port: portFromEnv("LIFECYCLE_SERVICE_PORT", 4002) });
