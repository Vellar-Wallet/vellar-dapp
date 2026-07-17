import { portFromEnv, startService } from "@vela/service-kit";
import { buildServer } from "./server";

const app = buildServer();
await startService(app, { port: portFromEnv("PORT", 4000) });
