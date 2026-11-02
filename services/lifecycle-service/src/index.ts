import {
  hostFromEnv,
  portFromEnv,
  startService,
  enforceDeployEnvPolicy,
} from "@vellar/service-kit";
import { createHorizonAccountReader } from "./horizon";
import { buildServer } from "./server";

// Staging tier policy (catalogue 1.4): DEPLOY_ENV=staging refuses to boot unless it is
// testnet-pinned, on its own database, with every production escape hatch unset.
enforceDeployEnvPolicy("lifecycle-service");

const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";

const app = buildServer({ reader: createHorizonAccountReader(horizonUrl) });
await startService(app, {
  port: portFromEnv("LIFECYCLE_SERVICE_PORT", 4002),
  host: hostFromEnv("127.0.0.1"),
});
