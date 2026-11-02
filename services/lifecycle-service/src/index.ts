import {
  hostFromEnv,
  portFromEnv,
  startService,
  enforceDeployEnvPolicy,
  horizonUrlFromEnv,
} from "@vellar/service-kit";
import { createHorizonAccountReader } from "./horizon";
import { buildServer } from "./server";

// Staging tier policy (catalogue 1.4): DEPLOY_ENV=staging refuses to boot unless it is
// testnet-pinned, on its own database, with every production escape hatch unset.
enforceDeployEnvPolicy("lifecycle-service");

// RA-10 class: Horizon follows the explicit STELLAR_NETWORK and refuses a mismatch; it never
// defaults to testnet.
const horizonUrl = horizonUrlFromEnv();

const app = buildServer({ reader: createHorizonAccountReader(horizonUrl) });
await startService(app, {
  port: portFromEnv("LIFECYCLE_SERVICE_PORT", 4002),
  host: hostFromEnv("127.0.0.1"),
});
