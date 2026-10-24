import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue #475 / security-audit.md RA-4: the fail-closed persistence boot
// guard (packages/service-kit/src/persistence.ts) has a pure-function unit
// test, but nothing anywhere in the repo spawns the actual deployed
// services/all-in-one process to confirm the exit-on-fail path fires
// end-to-end. This is that integration test.

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(serviceDir, "..");
const entrypoint = path.join(serviceDir, "index.ts");
const tsxBin = path.join(packageDir, "node_modules", ".bin", "tsx");

/**
 * Spawns the real all-in-one entrypoint with a controlled environment and
 * resolves once the process exits (or is killed after the timeout, which
 * fails the test rather than hanging CI forever).
 */
function runBoot(extraEnv: Record<string, string | undefined>) {
  return new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Explicitly clear the variables the fail-closed guard cares about so
    // this test's own environment can't accidentally mask the case under
    // test, then apply the scenario's overrides.
    delete env.NODE_ENV;
    delete env.DATABASE_URL;
    delete env.ALLOW_INMEMORY;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }

    const child = spawn(tsxBin, [entrypoint], {
      cwd: serviceDir,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("boot process did not exit within the test timeout"));
    }, 15_000);

    child.on("exit", (exitCode) => {
      clearTimeout(killTimer);
      resolve({ exitCode, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

describe("all-in-one boot sequence (RA-4 fail-closed guard, Issue #475)", () => {
  it("exits non-zero when DATABASE_URL is unset and NODE_ENV is unset (the real deploy-target condition)", async () => {
    const { exitCode, stderr } = await runBoot({});
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    // wallet-service is imported first in index.ts, so it is the one
    // that should report and exit before any other service starts.
    expect(stderr).toMatch(/wallet-service/);
  }, 20_000);

  it("does NOT fail closed when ALLOW_INMEMORY=1 is set, even with no DATABASE_URL", async () => {
    // This scenario boots past the guard but will still exit non-zero
    // further along (no relayer/sponsor credentials configured in this
    // test environment), so the assertion is narrowly scoped to what RA-4
    // itself controls: the process must NOT report the fail-closed
    // persistence error when the operator has explicitly opted in to
    // volatile storage.
    const { stderr } = await runBoot({ ALLOW_INMEMORY: "1" });
    expect(stderr).not.toMatch(/Refusing to run on volatile in-memory storage/);
  }, 20_000);
});
