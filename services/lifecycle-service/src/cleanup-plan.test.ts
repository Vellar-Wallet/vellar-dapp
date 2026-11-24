import { describe, expect, it } from "vitest";
import { buildCleanupPlan } from "./planner";
import type { HorizonAccount } from "./horizon";

describe("buildCleanupPlan response shape validation (#264)", () => {
  it("returns documented shape for clean account", () => {
    const mockAccount: HorizonAccount = {
      accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
      sequence: "100",
      subentryCount: 0,
      openOffers: 0,
      offers: [],
      balances: [{ assetType: "native", balance: "100.0" }],
      dataKeys: [],
    };

    const plan = buildCleanupPlan(
      mockAccount,
      "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
    );

    expect(plan).toHaveProperty("accountId");
    expect(plan).toHaveProperty("destination");
    expect(plan).toHaveProperty("blockers");
    expect(plan).toHaveProperty("estimatedTransactions");
    expect(plan).toHaveProperty("mergeReady");

    expect(Array.isArray(plan.blockers)).toBe(true);
    expect(plan.blockers.length).toBe(0);
    expect(plan.mergeReady).toBe(true);
    expect(plan.estimatedTransactions).toBe(1);
  });

  it("returns blockers array and mergeReady: false when blockers exist", () => {
    const mockAccount: HorizonAccount = {
      accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
      sequence: "100",
      subentryCount: 2,
      openOffers: 1,
      offers: [],
      balances: [
        { assetType: "native", balance: "100.0" },
        {
          assetType: "credit_alphanum4",
          assetCode: "USDC",
          assetIssuer: "GA5Z...",
          balance: "50.0",
        },
      ],
      dataKeys: ["app_config"],
    };

    const plan = buildCleanupPlan(
      mockAccount,
      "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
    );

    expect(plan.mergeReady).toBe(false);
    expect(plan.blockers.length).toBeGreaterThan(0);
    for (const blocker of plan.blockers) {
      expect(blocker).toHaveProperty("type");
      expect(blocker).toHaveProperty("description");
      expect(blocker).toHaveProperty("actionRequired");
    }
  });

  describe("spendable balance check upfront before building plan (#529)", () => {
    it("returns distinct result when account has zero spendable balance (all locked in base reserve)", () => {
      // 1 trustline (zero balance) => 1 subentry => base reserve is (2 + 1) * 0.5 = 1.5 XLM
      // Native balance is exactly 1.5 XLM => spendable balance is 0
      // 1 trustline removal op requires 100 stroops (0.00001 XLM)
      const mockAccount: HorizonAccount = {
        accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
        sequence: "100",
        subentryCount: 1,
        openOffers: 0,
        offers: [],
        balances: [
          { assetType: "native", balance: "1.5000000" },
          {
            assetType: "credit_alphanum4",
            assetCode: "USDC",
            assetIssuer: "GA5Z...",
            balance: "0",
          },
        ],
        dataKeys: [],
      };

      const result = buildCleanupPlan(
        mockAccount,
        "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
      );

      expect(result).toHaveProperty("error", "insufficient_spendable_balance");
      expect(result).toHaveProperty("canSelfFund", false);
      expect((result as any).message).toMatch(/cannot self-fund/i);
      expect((result as any).spendableBalanceXlm).toBe("0.0000000");
      expect((result as any).requiredFeeXlm).toBe("0.0000100");
    });

    it.each([
      ["1.0000001", "1", "0.0000001"],
      ["1.0000099", "99", "0.0000099"],
      ["1.0000100", "100", "0.0000100"],
      ["1.0000101", "101", "0.0000101"],
    ])("checks the merge fee with a native balance of %s XLM", (balance, stroops, spendableXlm) => {
      const account: HorizonAccount = {
        accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
        sequence: "100",
        subentryCount: 0,
        openOffers: 0,
        offers: [],
        balances: [{ assetType: "native", balance }],
        dataKeys: [],
      };
      const result = buildCleanupPlan(
        account,
        "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
      );

      if (Number(stroops) < 100) {
        expect(result).toMatchObject({
          error: "insufficient_spendable_balance",
          canSelfFund: false,
          spendableBalanceStroops: stroops,
          spendableBalanceXlm: spendableXlm,
          requiredFeeStroops: "100",
          requiredFeeXlm: "0.0000100",
          mergeReady: false,
        });
      } else {
        expect(result).toMatchObject({ blockers: [], estimatedTransactions: 1, mergeReady: true });
        expect(result).not.toHaveProperty("error");
      }
    });

    it("covers an account with exactly enough spendable balance for one operation but not the full plan", () => {
      // 1 trustline with balance > 0 requires 2 ops: payment (1) + trustline removal (1)
      // Total ops = 2 => required fee = 200 stroops (0.00002 XLM)
      // Reserve for 1 subentry = 1.5 XLM = 15,000,000 stroops
      // Native balance = 1.5000100 XLM (15,000,100 stroops)
      // Spendable balance = 100 stroops (0.0000100 XLM)
      // Exactly enough for 1 op (100 stroops), but NOT for the full 2-op plan (200 stroops)!
      const mockAccount: HorizonAccount = {
        accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
        sequence: "100",
        subentryCount: 1,
        openOffers: 0,
        offers: [],
        balances: [
          { assetType: "native", balance: "1.5000100" },
          {
            assetType: "credit_alphanum4",
            assetCode: "USDC",
            assetIssuer: "GA5Z...",
            balance: "10.0",
          },
        ],
        dataKeys: [],
      };

      const result = buildCleanupPlan(
        mockAccount,
        "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
      );

      // Must return clear distinct result explaining it cannot self-fund
      expect(result).toHaveProperty("error", "insufficient_spendable_balance");
      expect(result).toHaveProperty("canSelfFund", false);
      expect((result as any).message).toMatch(/cannot self-fund/i);
      expect((result as any).spendableBalanceXlm).toBe("0.0000100");
      expect((result as any).requiredFeeXlm).toBe("0.0000200");
      expect((result as any).spendableBalanceStroops).toBe("100");
      expect((result as any).requiredFeeStroops).toBe("200");
    });

    it("succeeds when account has sufficient spendable balance for the full plan", () => {
      // Native balance = 1.5000200 XLM => spendable balance = 200 stroops = required fee (200 stroops)
      const mockAccount: HorizonAccount = {
        accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
        sequence: "100",
        subentryCount: 1,
        openOffers: 0,
        offers: [],
        balances: [
          { assetType: "native", balance: "1.5000200" },
          {
            assetType: "credit_alphanum4",
            assetCode: "USDC",
            assetIssuer: "GA5Z...",
            balance: "10.0",
          },
        ],
        dataKeys: [],
      };

      const plan = buildCleanupPlan(
        mockAccount,
        "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
      );

      expect(plan).not.toHaveProperty("error");
      expect(plan.blockers.length).toBe(2);
      expect(plan.mergeReady).toBe(false);
    });
  });

  describe("safety check: incomplete pagination refuses plan (#531)", () => {
    it("refuses to build a plan if pagination was cut short", () => {
      const mockAccount: HorizonAccount = {
        accountId: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM",
        sequence: "100",
        subentryCount: 0,
        openOffers: 0,
        offers: [],
        balances: [{ assetType: "native", balance: "100.0" }],
        dataKeys: [],
        paginationIncomplete: true,
      };

      expect(() =>
        buildCleanupPlan(mockAccount, "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3"),
      ).toThrow(/pagination is incomplete/i);
    });
  });
});
