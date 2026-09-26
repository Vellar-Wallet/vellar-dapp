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
      balances: [{ assetType: "native", balance: "100.0" }],
      dataKeys: [],
    };

    const plan = buildCleanupPlan(mockAccount, "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3");

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
      balances: [
        { assetType: "native", balance: "100.0" },
        { assetType: "credit_alphanum4", assetCode: "USDC", assetIssuer: "GA5Z...", balance: "50.0" },
      ],
      dataKeys: ["app_config"],
    };

    const plan = buildCleanupPlan(mockAccount, "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3");

    expect(plan.mergeReady).toBe(false);
    expect(plan.blockers.length).toBeGreaterThan(0);
    for (const blocker of plan.blockers) {
      expect(blocker).toHaveProperty("type");
      expect(blocker).toHaveProperty("description");
      expect(blocker).toHaveProperty("actionRequired");
    }
  });
});
