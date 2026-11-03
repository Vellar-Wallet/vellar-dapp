import { describe, expect, it } from "vitest";
import { bootService } from "./boot-test-helper";

// lifecycle-service must STOP booting on a missing or contradictory Horizon setting.
describe("lifecycle-service boot: Horizon", () => {
  it("refuses to boot when STELLAR_NETWORK is unset (no testnet default)", () => {
    const r = bootService("lifecycle-service", {});
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull(); // exited on its own, not a timeout
    expect(r.stderr).toContain("STELLAR_NETWORK is not set");
  });

  it("refuses a mainnet deployment whose HORIZON_URL is the testnet Horizon", () => {
    const r = bootService("lifecycle-service", {
      STELLAR_NETWORK: "mainnet",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toContain("looks like testnet");
  });
});
