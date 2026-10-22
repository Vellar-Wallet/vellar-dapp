import { describe, expect, it, vi } from "vitest";
import {
  MAINNET_USDC_SAC,
  TESTNET_USDC_SAC,
  TOKEN_REGISTRY,
  findToken,
  formatAmountWithDecimals,
  getSupportedTokens,
  getTokenTrust,
  parseAmountWithDecimals,
} from "./tokens";
import { fetchBalances } from "./balances";

describe("Token Registry & Multi-Asset (#396)", () => {
  it("provides canonical registry containing USDC SAC for mainnet and testnet", () => {
    const mainnetTokens = getSupportedTokens("mainnet");
    const testnetTokens = getSupportedTokens("testnet");

    const mainnetUsdc = mainnetTokens.find((t) => t.symbol === "USDC");
    expect(mainnetUsdc).toBeDefined();
    expect(mainnetUsdc?.contractId).toBe(MAINNET_USDC_SAC);
    expect(mainnetUsdc?.decimals).toBe(7);

    const testnetUsdc = testnetTokens.find((t) => t.symbol === "USDC");
    expect(testnetUsdc).toBeDefined();
    expect(testnetUsdc?.contractId).toBe(TESTNET_USDC_SAC);
    expect(testnetUsdc?.decimals).toBe(7);

    const mainnetXlm = mainnetTokens.find((t) => t.symbol === "XLM");
    expect(mainnetXlm).toBeDefined();
    expect(mainnetXlm?.decimals).toBe(7);
  });

  it("finds tokens by symbol and contract address case-insensitively", () => {
    const bySymbol = findToken("mainnet", "usdc");
    expect(bySymbol?.contractId).toBe(MAINNET_USDC_SAC);

    const byContract = findToken("mainnet", MAINNET_USDC_SAC.toLowerCase());
    expect(byContract?.symbol).toBe("USDC");

    const unknown = findToken("mainnet", "UNKNOWN");
    expect(unknown).toBeUndefined();
  });

  describe("Arbitrary decimal conversion (verified with non-7-decimal tokens)", () => {
    it("formats and parses standard 7-decimal Stellar assets (USDC and XLM)", () => {
      const raw = 25_000_000n; // 2.5 XLM
      expect(formatAmountWithDecimals(raw, 7)).toBe("2.5");
      expect(parseAmountWithDecimals("2.5", 7)).toBe(raw);
      expect(parseAmountWithDecimals("0.0000001", 7)).toBe(1n);
    });

    it("formats and parses 6-decimal tokens correctly (e.g. EVM USDC standard)", () => {
      const decimals = 6;
      const amount = 1_500_000n; // 1.5
      expect(formatAmountWithDecimals(amount, decimals)).toBe("1.5");
      expect(parseAmountWithDecimals("1.5", decimals)).toBe(amount);

      const tiny = 1n; // 0.000001
      expect(formatAmountWithDecimals(tiny, decimals)).toBe("0.000001");
      expect(parseAmountWithDecimals("0.000001", decimals)).toBe(1n);
    });

    it("formats and parses 18-decimal tokens correctly (e.g. standard Soroban/EVM)", () => {
      const decimals = 18;
      const oneUnit = 10n ** 18n;
      expect(formatAmountWithDecimals(oneUnit, decimals)).toBe("1");
      expect(parseAmountWithDecimals("1", decimals)).toBe(oneUnit);

      const fractional = 1_250_000_000_000_000_000n; // 1.25
      expect(formatAmountWithDecimals(fractional, decimals)).toBe("1.25");
      expect(parseAmountWithDecimals("1.25", decimals)).toBe(fractional);
    });

    it("formats zero and handles negative numbers properly", () => {
      expect(formatAmountWithDecimals(0n, 7)).toBe("0");
      expect(formatAmountWithDecimals(-50_000_000n, 7)).toBe("-5");
    });

    it("rejects input with too many decimal places for the given token precision", () => {
      expect(() => parseAmountWithDecimals("1.12345678", 7)).toThrow(
        /Amount has 8 decimal places, but token only supports 7/,
      );
      expect(() => parseAmountWithDecimals("1.1234567", 6)).toThrow(
        /Amount has 7 decimal places, but token only supports 6/,
      );
    });

    it("rejects invalid numeric inputs", () => {
      expect(() => parseAmountWithDecimals("abc", 7)).toThrow(/not a valid amount/);
      expect(() => parseAmountWithDecimals("", 7)).toThrow(/Invalid amount/);
      expect(() => parseAmountWithDecimals(".", 7)).toThrow(/Invalid amount/);
    });
  });

  describe("Multi-asset balance query integration", () => {
    it("queries all registered tokens for the account", async () => {
      const balances = await fetchBalances("CTestAccount", "testnet");
      expect(balances.length).toBeGreaterThanOrEqual(2);

      const xlmBalance = balances.find((b) => b.symbol === "XLM");
      expect(xlmBalance).toBeDefined();

      const usdcBalance = balances.find((b) => b.symbol === "USDC");
      expect(usdcBalance).toBeDefined();
      expect(usdcBalance?.contractId).toBe(TESTNET_USDC_SAC);
    });
  });

  describe("Send-flow trust flag (#561)", () => {
    it("marks registry assets as allowlisted and verified without a warning flag", () => {
      for (const id of [TESTNET_USDC_SAC, "XLM", TESTNET_USDC_SAC.toLowerCase()]) {
        expect(getTokenTrust("testnet", id)).toEqual({
          allowlisted: true,
          verified: true,
          shouldFlag: false,
        });
      }
      expect(getTokenTrust("mainnet", MAINNET_USDC_SAC)).toEqual({
        allowlisted: true,
        verified: true,
        shouldFlag: false,
      });
    });

    it("flags a custom asset that is on no allowlist and has no verification record", () => {
      const custom = "CCUSTOM7NOTAREALCONTRACTID0000000000000000000000000000000";
      expect(getTokenTrust("testnet", custom)).toEqual({
        allowlisted: false,
        verified: false,
        shouldFlag: true,
      });
      // Lookup miss is the source of truth — findToken agrees.
      expect(findToken("testnet", custom)).toBeUndefined();
    });

    it("re-flags an asset that was previously allowlisted and has since been removed", () => {
      const registry = TOKEN_REGISTRY.testnet;
      const index = registry.findIndex((t) => t.contractId === TESTNET_USDC_SAC);
      expect(index).toBeGreaterThanOrEqual(0);
      const [removed] = registry.splice(index, 1);
      try {
        // Trust is evaluated live against the current registry, not cached.
        expect(getTokenTrust("testnet", TESTNET_USDC_SAC)).toEqual({
          allowlisted: false,
          verified: false,
          shouldFlag: true,
        });
        // The other registry entries are unaffected.
        expect(getTokenTrust("testnet", "XLM").shouldFlag).toBe(false);
      } finally {
        registry.splice(index, 0, removed!);
      }
      // Restored: the same asset is trusted again.
      expect(getTokenTrust("testnet", TESTNET_USDC_SAC).shouldFlag).toBe(false);
    });
  });
});
