import { describe, expect, it, vi } from "vitest";
import { configFromEnv, validateRelayerUrl } from "./config";

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

  describe("RELAYER_BASE_URL scheme validation (#603)", () => {
    it("accepts a valid https:// URL", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "https://relayer.example.com/v1",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("https://relayer.example.com/v1");
      expect(validateRelayerUrl("https://relayer.example.com/v1")).toBe(
        "https://relayer.example.com/v1",
      );
    });

    it("rejects a relayer URL missing a scheme and names the malformed URL", () => {
      expect(() =>
        configFromEnv({
          RELAYER_BASE_URL: "relayer.example.com",
          RELAYER_API_KEY: "k",
        }),
      ).toThrow(/relayer\.example\.com.*missing a scheme/i);

      expect(() => validateRelayerUrl("//relayer.example.com")).toThrow(
        /\/\/relayer\.example\.com.*missing a scheme/i,
      );
    });

    it("accepts http:// in non-production with a warning and rejects it in production", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const devConfig = configFromEnv({
          NODE_ENV: "development",
          RELAYER_BASE_URL: "http://localhost:8787",
          RELAYER_API_KEY: "k",
        });
        expect(devConfig.relayer?.baseUrl).toBe("http://localhost:8787");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/http:\/\/localhost:8787.*plain http:\/\//i),
        );

        expect(() =>
          configFromEnv({
            NODE_ENV: "production",
            RELAYER_BASE_URL: "http://relayer.example.com",
            RELAYER_API_KEY: "k",
          }),
        ).toThrow(/http:\/\/relayer\.example\.com.*plain http:\/\/ is not allowed in production/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it.each(["ftp://relayer.example.com", "ws://relayer.example.com", "wss://relayer.example.com"])(
      "rejects unsupported scheme %s with a clear error naming the URL",
      (badUrl) => {
        expect(() =>
          configFromEnv({
            RELAYER_BASE_URL: badUrl,
            RELAYER_API_KEY: "k",
          }),
        ).toThrow(new RegExp(`${badUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*unsupported scheme`, "i"));
      },
    );
  });
});

