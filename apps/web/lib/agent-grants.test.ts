// @vitest-environment node

import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  AgentGrantBalanceError,
  buildAgentGrants,
  describeAgentTrust,
  validateGrantBudgetsAgainstBalances,
} from "./agent-grants";

const c = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const USDC = c(1);
const XLM = c(2);
const BUDGET_USDC = c(3);
const BUDGET_XLM = c(4);
const VERIFIED = c(5);

describe("buildAgentGrants — verified-only (default policy)", () => {
  it("adds the verified-only policy as a required co-signer on every grant", () => {
    const { grants, decision } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC], [XLM]: [BUDGET_XLM] },
      verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
    });
    expect(grants).toEqual([
      { token: USDC, policies: [BUDGET_USDC, VERIFIED] },
      { token: XLM, policies: [BUDGET_XLM, VERIFIED] },
    ]);
    expect(decision).toEqual({
      mode: "verified-only",
      tokens: [USDC, XLM],
      verifiedOnlyPolicy: VERIFIED,
    });
  });

  it("never produces a grant whose only co-signer is the verified-only policy", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      }),
    ).toThrow(/spending-limit/);
  });

  it("dedupes budget policies and refuses the gate doubling as a budget", () => {
    const { grants } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC, BUDGET_USDC] },
      verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
    });
    expect(grants[0]?.policies).toEqual([BUDGET_USDC, VERIFIED]);
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [VERIFIED] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      }),
    ).toThrow(/double/);
  });

  it.each([
    [{ budgets: {} }, /at least one token/],
    [{ budgets: { GABC: [BUDGET_USDC] } }, /token/i],
    [{ budgets: { [USDC]: ["not-a-contract"] } }, /spending policy/],
  ])("rejects malformed input %#", (partial, message) => {
    expect(() =>
      buildAgentGrants({
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
        ...partial,
      }),
    ).toThrow(message);
  });

  it("rejects a malformed verified-only policy id", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [BUDGET_USDC] },
        verification: { mode: "verified-only", verifiedOnlyPolicy: "Cnope" },
      }),
    ).toThrow(/verified-only policy/);
  });
});

describe("buildAgentGrants — explicit override", () => {
  it("drops the gate only with a stated reason, and records it", () => {
    const { grants, decision } = buildAgentGrants({
      budgets: { [USDC]: [BUDGET_USDC] },
      verification: { mode: "unrestricted", reason: "  Paying our own unverified test contract  " },
    });
    expect(grants).toEqual([{ token: USDC, policies: [BUDGET_USDC] }]);
    expect(decision).toEqual({
      mode: "unrestricted",
      tokens: [USDC],
      reason: "Paying our own unverified test contract",
    });
  });

  it.each(["", "   ", "x".repeat(201)])("refuses an override with reason %j", (reason) => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [BUDGET_USDC] },
        verification: { mode: "unrestricted", reason },
      }),
    ).toThrow(/reason/);
  });

  it("keeps the spending limit even when verification is off", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [USDC]: [] },
        verification: { mode: "unrestricted", reason: "r" },
      }),
    ).toThrow(/spending-limit/);
  });
});

describe("buildAgentGrants — spendable balance check at mint time (#562)", () => {
  it("allows a grant budget that is less than or equal to the wallet's spendable balance", () => {
    const { grants } = buildAgentGrants({
      budgets: { [XLM]: [BUDGET_XLM], [USDC]: [BUDGET_USDC] },
      budgetAmounts: { [XLM]: "100000000", [USDC]: "50000000" },
      spendableBalances: { [XLM]: 100_000_000n, [USDC]: 75_000_000n },
      verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
    });
    expect(grants).toHaveLength(2);
  });

  it("blocks minting a grant whose budget exceeds the wallet's spendable balance", () => {
    expect(() =>
      buildAgentGrants({
        budgets: { [XLM]: [BUDGET_XLM] },
        budgetAmounts: { [XLM]: { amountBaseUnits: "250000000", symbol: "XLM" } },
        spendableBalances: { [XLM]: 100_000_000n },
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      }),
    ).toThrowError(AgentGrantBalanceError);
  });

  it("checks a non-native token grant budget against that token's spendable balance, not the native XLM balance", () => {
    // Wallet holds 10,000 XLM (100_000_000_000n) but only 5 USDC (50_000_000n).
    // Requesting a 20 USDC (200_000_000n) grant budget must fail despite the large native XLM balance.
    let caught: unknown;
    try {
      buildAgentGrants({
        budgets: { [USDC]: [BUDGET_USDC] },
        budgetAmounts: { [USDC]: { amountBaseUnits: 200_000_000n, symbol: "USDC" } },
        spendableBalances: [
          { token: XLM, spendable: 100_000_000_000n, symbol: "XLM" },
          { token: USDC, spendable: 50_000_000n, symbol: "USDC" },
        ],
        verification: { mode: "verified-only", verifiedOnlyPolicy: VERIFIED },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentGrantBalanceError);
    const balErr = caught as AgentGrantBalanceError;
    expect(balErr.token).toBe(USDC);
    expect(balErr.requested).toBe(200_000_000n);
    expect(balErr.spendable).toBe(50_000_000n);
    expect(balErr.message).toMatch(/USDC.*exceeds the wallet's current spendable balance/i);
  });

  it("treats a token absent from spendableBalances as having 0 spendable balance", () => {
    expect(() =>
      validateGrantBudgetsAgainstBalances({ [USDC]: "10000000" }, { [XLM]: 500_000_000n }),
    ).toThrowError(AgentGrantBalanceError);
  });
});

describe("describeAgentTrust — honesty bar", () => {
  const verified = describeAgentTrust({
    mode: "verified-only",
    tokens: [USDC],
    verifiedOnlyPolicy: VERIFIED,
  });
  const override = describeAgentTrust({ mode: "unrestricted", tokens: [USDC], reason: "testing" });

  it("never equates verified with safe", () => {
    for (const copy of [verified, override]) {
      expect(copy).not.toMatch(/\b(is|are|it's|as) safe\b/i);
      expect(copy).not.toMatch(/\bsafe (to|contract|resource)/i);
    }
    expect(verified).toMatch(/not that it is audited or safe/);
  });

  it("states the scope limit and the recovery paths", () => {
    expect(verified).toMatch(/nothing about who receives the payment/);
    expect(verified).toMatch(/get its contract verified/);
    expect(verified).toMatch(/pay it yourself with your passkey/);
    expect(verified).toMatch(/re-issue this key/);
  });

  it("makes the override and its reason visible", () => {
    expect(override).toMatch(/OFF/);
    expect(override).toMatch(/"testing"/);
  });
});
