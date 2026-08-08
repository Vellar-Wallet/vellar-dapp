import { describe, expect, it } from "vitest";
import { consumeSponsorBudget, enforceFeeCap, SPONSOR_DEFAULT_MAX_FEE_STROOPS } from "./sponsor";
import { SubmissionError } from "./relayer";

describe("enforceFeeCap", () => {
  it("accepts a simulated fee at or below the cap", () => {
    expect(() => enforceFeeCap("100000", SPONSOR_DEFAULT_MAX_FEE_STROOPS)).not.toThrow();
    expect(() =>
      enforceFeeCap(SPONSOR_DEFAULT_MAX_FEE_STROOPS, SPONSOR_DEFAULT_MAX_FEE_STROOPS),
    ).not.toThrow();
  });

  it("rejects a simulated fee above the cap with a coded SubmissionError", () => {
    // The old hardcoded 1-XLM bid (10,000,000) is now rejected by the default
    // 0.1-XLM (1,000,000) cap.
    let thrown: unknown;
    try {
      enforceFeeCap("10000000", SPONSOR_DEFAULT_MAX_FEE_STROOPS);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubmissionError);
    expect(thrown).toMatchObject({ code: "sponsor_fee_too_high" });
  });

  it("default cap is 0.1 XLM (1,000,000 stroops), a 10x reduction from the old 1-XLM ceiling", () => {
    expect(SPONSOR_DEFAULT_MAX_FEE_STROOPS).toBe("1000000");
  });

  it("honors a custom (looser) cap", () => {
    expect(() => enforceFeeCap("5000000", "10000000")).not.toThrow();
    expect(() => enforceFeeCap("10000001", "10000000")).toThrow(SubmissionError);
  });
});

describe("consumeSponsorBudget (FIX 3, fails closed)", () => {
  it("no-ops when no budget is wired", async () => {
    await expect(consumeSponsorBudget("100", undefined, undefined)).resolves.toBeUndefined();
    await expect(
      consumeSponsorBudget("100", { tryConsume: async () => ({ ok: true }) }, undefined),
    ).resolves.toBeUndefined();
  });

  it("consumes the sponsor line with the real fee and proceeds when allowed", async () => {
    const calls: unknown[] = [];
    const budget = {
      tryConsume: async (req: unknown) => {
        calls.push(req);
        return { ok: true as const };
      },
    };
    await expect(consumeSponsorBudget("12345", budget, "testnet")).resolves.toBeUndefined();
    expect(calls[0]).toEqual({ line: "sponsor", network: "testnet", stroops: 12345n });
  });

  it("throws sponsor_budget_exceeded when the budget refuses", async () => {
    const budget = { tryConsume: async () => ({ ok: false as const, reason: "budget_exceeded" }) };
    const attempt = consumeSponsorBudget("100", budget, "mainnet");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "sponsor_budget_exceeded" });
  });

  it("fails closed: an accounting error refuses (does not proceed)", async () => {
    const budget = {
      tryConsume: async () => {
        throw new Error("db down");
      },
    };
    await expect(consumeSponsorBudget("100", budget, "testnet")).rejects.toMatchObject({
      code: "sponsor_budget_exceeded",
    });
  });
});
