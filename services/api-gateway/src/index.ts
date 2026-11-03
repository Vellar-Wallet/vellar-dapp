import { portFromEnv, startService, enforceDeployEnvPolicy } from "@vellar/service-kit";
import { buildServer } from "./server";

// Staging tier policy (catalogue 1.4): DEPLOY_ENV=staging refuses to boot unless it is
// testnet-pinned, on its own database, with every production escape hatch unset.
enforceDeployEnvPolicy("api-gateway");

const app = buildServer();
await startService(app, { port: portFromEnv("PORT", 4000) });
