import { describe, expect, it } from "vitest";
import {
  MAINNET_NATIVE_SAC,
  MAINNET_USDC_SAC,
  TESTNET_NATIVE_SAC,
  TESTNET_USDC_SAC,
  assessTokenAllowlist,
  findToken,
  formatAmountWithDecimals,
  getSupportedTokens,
  isTokenAllowlisted,
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
    expect(mainnetUsdc?.allowlisted).toBe(true);
    expect(mainnetUsdc?.allowlistStatus).toBe("allowlisted");

    const testnetUsdc = testnetTokens.find((t) => t.symbol === "USDC");
    expect(testnetUsdc).toBeDefined();
    expect(testnetUsdc?.contractId).toBe(TESTNET_USDC_SAC);
    expect(testnetUsdc?.decimals).toBe(7);
    expect(testnetUsdc?.allowlisted).toBe(true);
    expect(testnetUsdc?.allowlistStatus).toBe("allowlisted");

    const mainnetXlm = mainnetTokens.find((t) => t.symbol === "XLM");
    expect(mainnetXlm).toBeDefined();
    expect(mainnetXlm?.decimals).toBe(7);
    expect(mainnetXlm?.allowlisted).toBe(true);
  });

  it("finds tokens by symbol and contract address case-insensitively", () => {
    const bySymbol = findToken("mainnet", "usdc");
    expect(bySymbol?.contractId).toBe(MAINNET_USDC_SAC);

    const byContract = findToken("mainnet", MAINNET_USDC_SAC.toLowerCase());
    expect(byContract?.symbol).toBe("USDC");

    const unknown = findToken("mainnet", "UNKNOWN");
    expect(unknown).toBeUndefined();
  });

  describe("Token allowlist check for send-flow visual flagging (#561)", () => {
    it("marks canonical registry assets as allowlisted without send-flow warning flags", () => {
      const xlm = assessTokenAllowlist("testnet", {
        contractId: TESTNET_NATIVE_SAC,
        symbol: "XLM",
        decimals: 7,
      });
      expect(xlm).toMatchObject({
        allowlisted: true,
        status: "allowlisted",
        flaggedForSendFlow: false,
        badgeLabel: null,
        warningCopy: null,
      });
      expect(isTokenAllowlisted("testnet", TESTNET_NATIVE_SAC)).toBe(true);
      expect(isTokenAllowlisted("mainnet", MAINNET_NATIVE_SAC)).toBe(true);
    });

    it("visually flags an arbitrary unverified custom asset (including symbol lookalikes)", () => {
      const impostorUsdc = {
        contractId: "CIMPOSTORUSDC11111111111111111111111111111111111111111111",
        symbol: "USDC",
        decimals: 7,
      };
      const assessment = assessTokenAllowlist("testnet", impostorUsdc);
      expect(assessment.allowlisted).toBe(false);
      expect(assessment.status).toBe("unverified");
      expect(assessment.flaggedForSendFlow).toBe(true);
      expect(assessment.badgeLabel).toBe("Unverified custom asset");
      expect(assessment.warningCopy).toMatch(/not on the verified token allowlist/i);
      expect(isTokenAllowlisted("testnet", impostorUsdc)).toBe(false);
    });

    it("distinguishes an asset that was previously allowlisted and has since been removed/revoked", () => {
      const revokedToken = {
        contractId: "CREVOKEDTOKEN1111111111111111111111111111111111111111111",
        symbol: "EURC",
        name: "Euro Coin",
        decimals: 7,
      };

      // Step 1: When present in the allowlist, the asset is allowlisted and unflagged.
      const beforeRemoval = assessTokenAllowlist("testnet", revokedToken, {
        allowlist: [...getSupportedTokens("testnet"), revokedToken],
      });
      expect(beforeRemoval.allowlisted).toBe(true);
      expect(beforeRemoval.status).toBe("allowlisted");
      expect(beforeRemoval.flaggedForSendFlow).toBe(false);

      // Step 2: Once removed from the active allowlist (compared against previousAllowlist or revokedContractIds),
      // it is flagged specifically as "revoked" rather than a generic unverified token.
      const afterRemoval = assessTokenAllowlist("testnet", revokedToken, {
        allowlist: getSupportedTokens("testnet"),
        previousAllowlist: [...getSupportedTokens("testnet"), revokedToken],
      });
      expect(afterRemoval.allowlisted).toBe(false);
      expect(afterRemoval.status).toBe("revoked");
      expect(afterRemoval.flaggedForSendFlow).toBe(true);
      expect(afterRemoval.badgeLabel).toBe("Removed from allowlist");
      expect(afterRemoval.warningCopy).toMatch(/previously allowlisted.*removed/i);

      // Step 3: Explicit revocation via revokedContractIds on an otherwise allowlisted token also flags as "revoked".
      const explicitlyRevoked = assessTokenAllowlist(
        "testnet",
        { contractId: TESTNET_USDC_SAC, symbol: "USDC", decimals: 7 },
        { revokedContractIds: [TESTNET_USDC_SAC] },
      );
      expect(explicitlyRevoked.allowlisted).toBe(false);
      expect(explicitlyRevoked.status).toBe("revoked");
      expect(explicitlyRevoked.flaggedForSendFlow).toBe(true);
      expect(
        isTokenAllowlisted("testnet", TESTNET_USDC_SAC, {
          revokedContractIds: [TESTNET_USDC_SAC],
        }),
      ).toBe(false);
    });
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
});
