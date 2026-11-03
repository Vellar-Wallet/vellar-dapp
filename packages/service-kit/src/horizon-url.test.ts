import { describe, expect, it } from "vitest";
import { horizonUrlFromEnv } from "./horizon-url";
import { NetworkConfigError } from "./network-config";

const TESTNET = "https://horizon-testnet.stellar.org";
const MAINNET = "https://horizon.stellar.org";

describe("horizonUrlFromEnv", () => {
  it("derives the testnet Horizon from STELLAR_NETWORK=testnet when HORIZON_URL is unset", () => {
    expect(horizonUrlFromEnv({ STELLAR_NETWORK: "testnet" })).toBe(TESTNET);
  });

  it("derives the MAINNET Horizon from STELLAR_NETWORK=mainnet (never falls back to testnet)", () => {
    expect(horizonUrlFromEnv({ STELLAR_NETWORK: "mainnet" })).toBe(MAINNET);
  });

  it("treats a blank HORIZON_URL as unset", () => {
    expect(horizonUrlFromEnv({ STELLAR_NETWORK: "mainnet", HORIZON_URL: "  " })).toBe(MAINNET);
  });

  it.each([
    ["testnet", TESTNET],
    ["mainnet", MAINNET],
  ])("accepts an explicit HORIZON_URL that agrees with STELLAR_NETWORK=%s", (network, url) => {
    expect(horizonUrlFromEnv({ STELLAR_NETWORK: network, HORIZON_URL: url })).toBe(url);
  });

  it("refuses when STELLAR_NETWORK is unset, even if HORIZON_URL is set", () => {
    expect(() => horizonUrlFromEnv({})).toThrow(NetworkConfigError);
    expect(() => horizonUrlFromEnv({ HORIZON_URL: TESTNET })).toThrow(/STELLAR_NETWORK is not set/);
  });

  it("refuses an invalid STELLAR_NETWORK", () => {
    expect(() => horizonUrlFromEnv({ STELLAR_NETWORK: "futurenet" })).toThrow(
      /not a valid network/,
    );
  });

  it("refuses a mainnet deployment pointed at the testnet Horizon, naming both values", () => {
    expect(() => horizonUrlFromEnv({ STELLAR_NETWORK: "mainnet", HORIZON_URL: TESTNET })).toThrow(
      /STELLAR_NETWORK='mainnet' but HORIZON_URL looks like testnet/,
    );
  });

  it("refuses a testnet deployment pointed at the mainnet Horizon", () => {
    expect(() => horizonUrlFromEnv({ STELLAR_NETWORK: "testnet", HORIZON_URL: MAINNET })).toThrow(
      /looks like mainnet/,
    );
  });

  it.each(["https://horizon.example.com", "not a url", "http://localhost:8000"])(
    "refuses an unrecognized HORIZON_URL (%s) rather than guessing",
    (url) => {
      expect(() => horizonUrlFromEnv({ STELLAR_NETWORK: "mainnet", HORIZON_URL: url })).toThrow(
        /unrecognized/,
      );
    },
  );

  it("does not accept a lookalike host that merely contains the real one", () => {
    expect(() =>
      horizonUrlFromEnv({
        STELLAR_NETWORK: "mainnet",
        HORIZON_URL: "https://horizon.stellar.org.evil.example",
      }),
    ).toThrow(/unrecognized/);
  });
});
