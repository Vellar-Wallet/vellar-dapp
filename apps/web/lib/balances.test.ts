import { describe, expect, it } from "vitest";
import { normalizeTokenBalance } from "./balances";

describe("normalizeTokenBalance", () => {
  it("keeps positive available balance unchanged when no liabilities exist", () => {
    const normalized = normalizeTokenBalance({
      contractId: "CXL M",
      symbol: "XLM",
      decimals: 7,
      amount: 12_500_000n,
      sellingLiabilities: 0n,
    } as any);

    expect(normalized.amount).toBe(12_500_000n);
  });

  it("clamps available balance to zero when selling liabilities exceed raw balance", () => {
    const normalized = normalizeTokenBalance({
      contractId: "CUSD",
      symbol: "USDC",
      decimals: 7,
      amount: 5_000_000n,
      sellingLiabilities: 7_000_000n,
    } as any);

    expect(normalized.amount).toBe(0n);
  });

  it("supports stellar-sdk style selling_liabilities and string amounts", () => {
    const normalized = normalizeTokenBalance({
      contractId: "CUSD",
      symbol: "USDC",
      decimals: 7,
      balance: "10.0000000", // not bigint-parsable decimal string; should be ignored
      amount: "10000000",
      selling_liabilities: "3000000",
    } as any);

    expect(normalized.amount).toBe(7_000_000n);
  });

  it("does not modify balances without a parseable raw amount", () => {
    const original = {
      contractId: "CUSD",
      symbol: "USDC",
      decimals: 7,
      amount: "not-a-number",
    } as any;

    expect(normalizeTokenBalance(original)).toEqual(original);
  });
});
