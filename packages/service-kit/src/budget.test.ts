import { describe, expect, it } from "vitest";
import {
  budgetLimitsFromEnv,
  createUnavailableBudget,
  withinCeiling,
  type BudgetLimits,
} from "./budget";

describe("withinCeiling (pure ceiling logic)", () => {
  const limits: BudgetLimits = { maxStroops: 500_000_000n, maxCount: 500 };

  it("accepts when adding one call stays under both dimensions", () => {
    expect(withinCeiling({ priorStroops: 0n, priorCount: 0 }, 100_000n, limits)).toBe(true);
  });

  it("rejects when the XLM dimension would be exceeded (tighter dimension trips first)", () => {
    expect(
      withinCeiling({ priorStroops: 500_000_000n, priorCount: 1 }, 1n, limits),
    ).toBe(false);
  });

  it("rejects when the COUNT dimension would be exceeded even if XLM has room", () => {
    expect(withinCeiling({ priorStroops: 0n, priorCount: 500 }, 1n, limits)).toBe(false);
  });

  it("count-only line (maxStroops omitted) ignores the XLM dimension", () => {
    const createLimits: BudgetLimits = { maxCount: 30 };
    expect(withinCeiling({ priorStroops: 0n, priorCount: 29 }, 0n, createLimits)).toBe(true);
    expect(withinCeiling({ priorStroops: 0n, priorCount: 30 }, 0n, createLimits)).toBe(false);
  });

  it("boundary: exactly at the ceiling is allowed, one over is not", () => {
    expect(withinCeiling({ priorStroops: 499_999_999n, priorCount: 0 }, 1n, limits)).toBe(true);
    expect(withinCeiling({ priorStroops: 500_000_000n, priorCount: 0 }, 1n, limits)).toBe(false);
  });
});

describe("createUnavailableBudget (fail-closed stub)", () => {
  it("always refuses — an unaccountable budget must never allow unmetered spend", async () => {
    const budget = createUnavailableBudget();
    const r = await budget.tryConsume({ line: "sponsor", network: "testnet", stroops: 1n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("budget_unavailable");
  });
});

describe("budgetLimitsFromEnv", () => {
  it("reads XLM (as XLM units → stroops) and count from env with defaults", () => {
    const limits = budgetLimitsFromEnv(
      { maxXlmVar: "BUDGET_SPONSOR_MAX_XLM", maxCountVar: "BUDGET_SPONSOR_MAX_COUNT" },
      { defaultMaxXlm: 50, defaultMaxCount: 500 },
      { BUDGET_SPONSOR_MAX_XLM: "10", BUDGET_SPONSOR_MAX_COUNT: "42" },
    );
    expect(limits).toEqual({ maxStroops: 100_000_000n, maxCount: 42 });
  });

  it("falls back to defaults when env is unset", () => {
    const limits = budgetLimitsFromEnv(
      { maxXlmVar: "BUDGET_SPONSOR_MAX_XLM", maxCountVar: "BUDGET_SPONSOR_MAX_COUNT" },
      { defaultMaxXlm: 50, defaultMaxCount: 500 },
      {},
    );
    expect(limits).toEqual({ maxStroops: 500_000_000n, maxCount: 500 });
  });

  it("count-only line: no maxXlmVar yields a limit with no XLM ceiling", () => {
    const limits = budgetLimitsFromEnv(
      { maxCountVar: "BUDGET_CREATE_MAX_COUNT" },
      { defaultMaxCount: 30 },
      {},
    );
    expect(limits).toEqual({ maxCount: 30 });
  });
});
