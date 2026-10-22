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

  describe("relayer URL scheme validation", () => {
    it("accepts valid https:// URLs", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "https://relayer.example.com",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("https://relayer.example.com");
    });

    it("accepts valid https:// URLs with paths and ports", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "https://relayer.example.com:8443/api/v1",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("https://relayer.example.com:8443/api/v1");
    });

    it("rejects URLs without a scheme", () => {
      expect(() => {
        configFromEnv({
          RELAYER_BASE_URL: "relayer.example.com",
          RELAYER_API_KEY: "k",
        });
      }).toThrow(/not a valid URL/);
    });

    it("rejects malformed URLs", () => {
      expect(() => {
        configFromEnv({
          RELAYER_BASE_URL: "ht!tp://[invalid]",
          RELAYER_API_KEY: "k",
        });
      }).toThrow(/not a valid URL/);
    });

    it("allows http:// for localhost development", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "http://localhost:3000",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("http://localhost:3000");
    });

    it("allows http:// for 127.0.0.1", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "http://127.0.0.1:3000",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("http://127.0.0.1:3000");
    });

    it("allows http:// for IPv6 localhost", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "http://[::1]:3000",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("http://[::1]:3000");
    });

    it("allows http:// for internal 192.168.x.x addresses", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "http://192.168.1.100:3000",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("http://192.168.1.100:3000");
    });

    it("allows http:// for internal 10.x.x.x addresses", () => {
      const config = configFromEnv({
        RELAYER_BASE_URL: "http://10.0.0.1:3000",
        RELAYER_API_KEY: "k",
      });
      expect(config.relayer?.baseUrl).toBe("http://10.0.0.1:3000");
    });

    it("rejects http:// for public domains", () => {
      expect(() => {
        configFromEnv({
          RELAYER_BASE_URL: "http://relayer.example.com",
          RELAYER_API_KEY: "k",
        });
      }).toThrow(/uses http:\/\/ scheme.*Relayer URLs must use https/);
    });

    it("rejects unsupported schemes like ftp://", () => {
      expect(() => {
        configFromEnv({
          RELAYER_BASE_URL: "ftp://relayer.example.com",
          RELAYER_API_KEY: "k",
        });
      }).toThrow(/has scheme "ftp:".*Only https:\/\/ and http:\/\/localhost are supported/);
    });

    it("rejects unsupported schemes like ws://", () => {
      expect(() => {
        configFromEnv({
          RELAYER_BASE_URL: "ws://relayer.example.com",
          RELAYER_API_KEY: "k",
        });
      }).toThrow(/has scheme "ws:".*Only https:\/\/ and http:\/\/localhost are supported/);
    });

    it("error message includes the malformed URL for debugging", () => {
      try {
        configFromEnv({
          RELAYER_BASE_URL: "definitely not a url",
          RELAYER_API_KEY: "k",
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("definitely not a url");
      }
    });

    it("error message for http:// includes the problematic URL", () => {
      try {
        configFromEnv({
          RELAYER_BASE_URL: "http://public.example.com",
          RELAYER_API_KEY: "k",
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("public.example.com");
      }
    });
  });
});
