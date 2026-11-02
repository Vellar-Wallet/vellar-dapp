import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The two services that gate on an x402 facilitator must actually STOP booting
// when its URL is missing or unusable. This runs each real entrypoint as a child
// process with a clean environment (it fails before opening a port or touching a
// database, so it exits in well under a second).

const serviceDir = (service: string) =>
  fileURLToPath(new URL(`../../../services/${service}`, import.meta.url));

function boot(service: string, env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serviceDir(service),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      // publicBaseUrlFromEnv() runs first at construction; give it a valid one so
      // the facilitator check is what is under test.
      PUBLIC_BASE_URL: "https://vellar-backend-production.up.railway.app",
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe.each(["lifecycle-service", "verification-service"])("%s boot", (service) => {
  it("refuses to boot when FACILITATOR_URL is unset (no built-in host)", () => {
    const r = boot(service, {});
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull(); // not a timeout: it exited on its own
    expect(r.stderr).toContain("FACILITATOR_URL is not set");
  });

  it("refuses a retired Render host", () => {
    const r = boot(service, { FACILITATOR_URL: "https://vellar-facilitator.onrender.com" });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain("Render");
  });

  it("refuses plain http to a non-loopback host", () => {
    const r = boot(service, { FACILITATOR_URL: "http://facilitator.example.com" });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain("https");
  });
});
