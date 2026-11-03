import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The staging policy has to actually STOP a boot, not just be a function that
// returns violations. This runs the real wallet-service entrypoint as a child
// process (it refuses before it opens a port or touches a database, so it exits
// in milliseconds) and checks the exit code and message.

const serviceDir = fileURLToPath(new URL("..", import.meta.url));

function boot(env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serviceDir,
    // A clean environment: nothing leaks in from the developer's shell or .env.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("wallet-service boot enforces DEPLOY_ENV=staging", () => {
  it("exits 1 naming every violation when staging is pointed at mainnet", () => {
    const r = boot({
      DEPLOY_ENV: "staging",
      STELLAR_NETWORK: "mainnet",
      ALLOW_INMEMORY: "1",
      CORS_ORIGIN: "https://vellar.xyz",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[wallet-service]");
    expect(r.stderr).toContain("STELLAR_NETWORK must be 'testnet'");
    expect(r.stderr).toContain("DATABASE_URL is required");
    expect(r.stderr).toContain("ALLOW_INMEMORY");
    expect(r.stderr).toContain("CORS_ORIGIN");
  });

  it("exits 1 on an unrecognised DEPLOY_ENV rather than treating it as production", () => {
    const r = boot({ DEPLOY_ENV: "stage", STELLAR_NETWORK: "testnet" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DEPLOY_ENV");
  });
});
