import { describe, expect, it } from "vitest";
import { bootService } from "./boot-test-helper";

// The two services that gate on an x402 facilitator must actually STOP booting
// when its URL is missing or unusable. This runs each real entrypoint as a child
// process with a clean environment (it fails before opening a port or touching a
// database). STELLAR_NETWORK is given because lifecycle-service checks its network
// (for Horizon) before it reaches the facilitator check.

const boot = (service: string, env: Record<string, string>) =>
  bootService(service, { STELLAR_NETWORK: "testnet", ...env });

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
