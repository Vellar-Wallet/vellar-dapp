import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Runs a REAL service entrypoint as a child process with a clean environment, for tests
// that assert it refuses to boot. The refusals under test happen before the service
// opens a port or a database, so each exits in well under a second.

const serviceDir = (service: string) =>
  fileURLToPath(new URL(`../../../services/${service}`, import.meta.url));

export function bootService(service: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serviceDir(service),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      // publicBaseUrlFromEnv() runs first at construction in some services; give it a
      // valid one so the setting under test is what fails.
      PUBLIC_BASE_URL: "https://vellar-backend-production.up.railway.app",
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
}
