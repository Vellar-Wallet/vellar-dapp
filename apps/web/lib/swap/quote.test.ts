// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { assetsFor } from "@/lib/assets";
import {
  assessQuoteStaleness,
  assertQuoteFresh,
  assertSlippageBps,
  ensureFreshQuote,
  formatRate,
  isQuoteFresh,
  isQuoteStale,
  minimumOut,
  normalizeQuote,
  parseSlippagePercent,
  QUOTE_TTL_MS,
  quotedRate,
  slippageBound,
  StaleSwapQuoteError,
  worstCaseRate,
} from "./quote";

const [XLM, USDC] = assetsFor("testnet") as [
  ReturnType<typeof assetsFor>[number],
  ReturnType<typeof assetsFor>[number],
];

function quote(amountIn = 100_000_000n, out = 10_540_793n) {
  return normalizeQuote({
    sell: XLM,
    buy: USDC,
    amountIn,
    path: [XLM.contractId, USDC.contractId],
    hopAmounts: [amountIn, out],
    quotedAt: 1_000,
  });
}

describe("slippage", () => {
  it("floors the minimum output (never rounds in the user's disfavour upward)", () => {
    // 10_540_793 × 0.995 = 10_488_089.035 -> 10_488_089
    expect(minimumOut(10_540_793n, 50)).toBe(10_488_089n);
    expect(minimumOut(10_000n, 1)).toBe(9_999n);
    expect(minimumOut(10_000n, 500)).toBe(9_500n);
  });

  it("refuses a zero minimum — the router would then accept any output", () => {
    expect(() => minimumOut(1n, 50)).toThrow(/too small/);
    expect(() => minimumOut(0n, 50)).toThrow(/no output/);
  });

  it.each([0, -1, 501, 0.5, Number.NaN])("rejects tolerance %s bps", (bps) => {
    expect(() => assertSlippageBps(bps)).toThrow(/Slippage/);
  });

  it.each([
    ["0.5", 50],
    ["1", 100],
    ["0.01", 1],
    ["5", 500],
    [" 2.25 ", 225],
  ])("parses %j%% as %i bps", (input, bps) => {
    expect(parseSlippagePercent(input)).toBe(bps);
  });

  it.each(["", "abc", "-1", "0", "5.01", "10", "0.001", "1e1"])("rejects %j", (input) => {
    expect(() => parseSlippagePercent(input)).toThrow();
  });
});

describe("rates", () => {
  it("formats the quoted and worst-case rate from integer amounts", () => {
    const q = quote();
    const bound = slippageBound(q, 50);
    expect(quotedRate(q)).toBe("0.1054079");
    expect(worstCaseRate(q, bound)).toBe("0.1048808");
    expect(bound.minOut).toBe(10_488_089n);
  });

  it("truncates rather than rounds", () => {
    // 2 / 3 = 0.6666666…
    expect(formatRate(3n, 2n, 7, 7)).toBe("0.6666666");
    expect(formatRate(1n, 5n, 7, 7)).toBe("5");
  });

  it("handles differing decimals", () => {
    // 1.0 (7dp) in -> 2.5 (6dp) out
    expect(formatRate(10_000_000n, 2_500_000n, 7, 6)).toBe("2.5");
  });
});

describe("normalizeQuote", () => {
  it("builds a quote and exposes the route", () => {
    const q = quote();
    expect(q.expectedOut).toBe(10_540_793n);
    expect(q.path).toEqual([XLM.contractId, USDC.contractId]);
  });

  it.each([
    ["same asset", { buy: XLM }],
    ["zero input", { amountIn: 0n, hopAmounts: [0n, 5n] }],
    ["route for other assets", { path: [USDC.contractId, XLM.contractId] }],
    ["one-hop path", { path: [XLM.contractId], hopAmounts: [100n] }],
    ["hop count mismatch", { hopAmounts: [100n] }],
    ["input mismatch", { hopAmounts: [99n, 5n] }],
    ["no liquidity", { hopAmounts: [100n, 0n] }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      normalizeQuote({
        sell: XLM,
        buy: USDC,
        amountIn: 100n,
        path: [XLM.contractId, USDC.contractId],
        hopAmounts: [100n, 5n],
        quotedAt: 0,
        ...override,
      }),
    ).toThrow();
  });

  it("expires after the TTL", () => {
    const q = quote();
    expect(isQuoteFresh(q, q.quotedAt + QUOTE_TTL_MS)).toBe(true);
    expect(isQuoteFresh(q, q.quotedAt + QUOTE_TTL_MS + 1)).toBe(false);
  });

  describe("quote staleness check and boundary handling (#555)", () => {
    it("treats a quote right at the boundary age (age === maxAgeMs) as fresh and 1ms past as stale", () => {
      const q = quote(); // quotedAt = 1_000
      const customMaxAgeMs = 15_000;
      const boundaryNow = q.quotedAt + customMaxAgeMs;

      const atBoundary = assessQuoteStaleness(q, boundaryNow, customMaxAgeMs);
      expect(atBoundary).toEqual({
        isFresh: true,
        isStale: false,
        ageMs: customMaxAgeMs,
        maxAgeMs: customMaxAgeMs,
        remainingMs: 0,
        requiresRequote: false,
      });
      expect(isQuoteFresh(q, boundaryNow, customMaxAgeMs)).toBe(true);
      expect(isQuoteStale(q, boundaryNow, customMaxAgeMs)).toBe(false);
      expect(() => assertQuoteFresh(q, boundaryNow, customMaxAgeMs)).not.toThrow();

      const pastBoundary = assessQuoteStaleness(q, boundaryNow + 1, customMaxAgeMs);
      expect(pastBoundary).toEqual({
        isFresh: false,
        isStale: true,
        ageMs: customMaxAgeMs + 1,
        maxAgeMs: customMaxAgeMs,
        remainingMs: 0,
        requiresRequote: true,
      });
      expect(isQuoteFresh(q, boundaryNow + 1, customMaxAgeMs)).toBe(false);
      expect(isQuoteStale(q, boundaryNow + 1, customMaxAgeMs)).toBe(true);
    });

    it("throws StaleSwapQuoteError with requiresRequote=true when assertQuoteFresh fails before building a transaction", () => {
      const q = quote(); // quotedAt = 1_000
      expect(() => assertQuoteFresh(q, q.quotedAt + QUOTE_TTL_MS + 500)).toThrowError(
        StaleSwapQuoteError,
      );

      try {
        assertQuoteFresh(q, q.quotedAt + 10_001, 10_000);
        expect.unreachable("should have thrown StaleSwapQuoteError");
      } catch (err) {
        expect(err).toBeInstanceOf(StaleSwapQuoteError);
        expect(err).toMatchObject({
          name: "StaleSwapQuoteError",
          code: "STALE_SWAP_QUOTE",
          requiresRequote: true,
          ageMs: 10_001,
          maxAgeMs: 10_000,
          quotedAt: 1_000,
          evaluatedAt: 11_001,
        });
      }
    });

    it("forces a re-quote via ensureFreshQuote when the quote exceeds maxAgeMs, and skips re-quoting at the boundary", async () => {
      const initialQuote = quote(); // quotedAt = 1_000
      const refreshedQuote = { ...initialQuote, expectedOut: 10_800_000n, quotedAt: 16_000 };
      const requote = vi.fn(async () => refreshedQuote);

      // Right at the boundary (age = 15_000ms, maxAgeMs = 15_000ms): no re-quote triggered
      const boundaryResult = await ensureFreshQuote(initialQuote, {
        now: 16_000,
        maxAgeMs: 15_000,
        requote,
      });
      expect(boundaryResult).toEqual({ quote: initialQuote, wasRefreshed: false });
      expect(requote).not.toHaveBeenCalled();

      // 1ms past the boundary (age = 15_001ms > 15_000ms): forces a re-quote
      const staleResult = await ensureFreshQuote(initialQuote, {
        now: 16_001,
        maxAgeMs: 15_000,
        requote,
      });
      expect(requote).toHaveBeenCalledTimes(1);
      expect(staleResult).toEqual({ quote: refreshedQuote, wasRefreshed: true });
    });

    it("rejects non-positive maxAgeMs configuration", () => {
      const q = quote();
      expect(() => isQuoteFresh(q, 2_000, 0)).toThrow(/positive/);
      expect(() => isQuoteFresh(q, 2_000, -5_000)).toThrow(/positive/);
    });
  });
});
