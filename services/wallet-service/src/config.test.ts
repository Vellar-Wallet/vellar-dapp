import { describe, expect, it } from "vitest";
import { configFromEnv } from "./config";

describe("configFromEnv", () => {
  it("returns undefined relayer when the key or base URL is missing", () => {
    expect(configFromEnv({}).relayer).toBeUndefined();
    expect(configFromEnv({ RELAYER_BASE_URL: "https://r.example" }).relayer).toBeUndefined();
    expect(configFromEnv({ RELAYER_API_KEY: "k" }).relayer).toBeUndefined();
  });

  it("carries DATABASE_URL through regardless of relayer config", () => {
    expect(configFromEnv({}).databaseUrl).toBeUndefined();
    expect(configFromEnv({ DATABASE_URL: "postgres://x" }).databaseUrl).toBe("postgres://x");
    expect(
      configFromEnv({
        DATABASE_URL: "postgres://x",
        RELAYER_BASE_URL: "https://r.example",
        RELAYER_API_KEY: "k",
      }).databaseUrl,
    ).toBe("postgres://x");
  });

  it("defaults RPC and passphrase to testnet", () => {
    const config = configFromEnv({
      RELAYER_BASE_URL: "https://r.example",
      RELAYER_API_KEY: "k",
    });
    expect(config.relayer).toEqual({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      baseUrl: "https://r.example",
      apiKey: "k",
    });
  });

  it("honors explicit RPC and passphrase overrides", () => {
    const config = configFromEnv({
      RELAYER_BASE_URL: "https://r.example",
      RELAYER_API_KEY: "k",
      STELLAR_RPC_URL: "https://rpc.mainnet.example",
      STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    });
    expect(config.relayer?.rpcUrl).toBe("https://rpc.mainnet.example");
    expect(config.relayer?.networkPassphrase).toBe(
      "Public Global Stellar Network ; September 2015",
    );
  });
});
