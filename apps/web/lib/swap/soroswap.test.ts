// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  assertMeetsMinOut,
  assertSlippageWithin,
  createSoroswapVenue,
  SWAP_DEADLINE_SECONDS,
  SwapVenueError,
} from "./soroswap";

const BASE = {
  amountIn: 100_000_000n,
  minOut: 99_000_000n,
  slippageBps: 100,
  path: ["CSell", "CBuy"],
  to: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  deadline: 1_000n + BigInt(SWAP_DEADLINE_SECONDS),
};

function venue(maxSlippageBps?: number) {
  return createSoroswapVenue({
    network: "testnet",
    rpcUrl: "https://example.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...(maxSlippageBps === undefined ? {} : { maxSlippageBps }),
  });
}

describe("assertSlippageWithin", () => {
  it("accepts a tolerance inside the configured bound", () => {
    expect(() => assertSlippageWithin(100, 500)).not.toThrow();
    expect(() => assertSlippageWithin(1, 500)).not.toThrow();
    expect(() => assertSlippageWithin(500, 500)).not.toThrow();
  });

  it("rejects a tolerance above the configured maximum", () => {
    expect(() => assertSlippageWithin(501, 500)).toThrow(SwapVenueError);
    expect(() => assertSlippageWithin(200, 100)).toThrow(/Slippage must be between/);
  });

  it("rejects non-integer and out-of-range tolerances", () => {
    expect(() => assertSlippageWithin(0, 500)).toThrow(SwapVenueError);
    expect(() => assertSlippageWithin(-10, 500)).toThrow(SwapVenueError);
    expect(() => assertSlippageWithin(1.5, 500)).toThrow(SwapVenueError);
  });

  it("reports the configurable maximum in the error", () => {
    expect(() => assertSlippageWithin(101, 100)).toThrow(/1%/);
  });
});

describe("assertMeetsMinOut", () => {
  it("returns the simulated output when it meets the floor", () => {
    expect(assertMeetsMinOut([100n, 99n], 99n)).toBe(99n);
    expect(assertMeetsMinOut([100n, 120n], 99n)).toBe(120n);
  });

  it("refuses when the live simulation lands below the floor (price moved)", () => {
    expect(() => assertMeetsMinOut([100n, 98n], 99n)).toThrow(SwapVenueError);
    expect(() => assertMeetsMinOut([100n, 1n], 99n)).toThrow(/price moved/);
  });

  it("refuses an empty simulation rather than yielding undefined downstream", () => {
    expect(() => assertMeetsMinOut([], 99n)).toThrow(SwapVenueError);
    expect(() => assertMeetsMinOut([], 99n)).toThrow(/price moved/);
  });

  it("keeps the router code so the caller can match on it", () => {
    try {
      assertMeetsMinOut([100n, 1n], 99n);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SwapVenueError);
      expect((e as SwapVenueError).code).toBe(507);
    }
  });
});

describe("createSoroswapVenue buildSwap validation", () => {
  it("rejects a slippage tolerance above the venue maximum before building", async () => {
    const v = venue(100);
    await expect(v.buildSwap({ ...BASE, slippageBps: 101 })).rejects.toThrow(/Slippage must be/);
  });

  it("rejects a zero slippage tolerance before building", async () => {
    await expect(venue().buildSwap({ ...BASE, slippageBps: 0 })).rejects.toThrow(
      /Slippage must be/,
    );
  });

  it("uses the shared default maximum when none is configured", async () => {
    // 501 bps is over the shared MAX_SLIPPAGE_BPS ceiling of 5%.
    await expect(venue().buildSwap({ ...BASE, slippageBps: 501 })).rejects.toThrow(
      /Slippage must be/,
    );
  });

  it("does not reject a tolerance exactly at a tighter venue maximum", async () => {
    const err = await venue(50)
      .buildSwap({ ...BASE, slippageBps: 50 })
      .then(() => null, (e: unknown) => e);
    // The bound is inclusive: past it the failure is the venue, not the bound.
    if (err instanceof SwapVenueError) {
      expect(err.message).not.toMatch(/Slippage must be/);
    }
  });
});

describe("assertMeetsMinOut re-validation semantics", () => {
  it("trusts the live simulation over the original quote's expected output", () => {
    // The quote said 105; the pool now pays 99.9. The floor is 99, so the swap
    // is still allowed — but only because the simulation says so.
    expect(assertMeetsMinOut([100n, 99n], 99n)).toBe(99n);
    // The quote said 105; the pool now pays 98. Refused even though the original
    // quote would have cleared the floor.
    expect(() => assertMeetsMinOut([100n, 98n], 99n)).toThrow(SwapVenueError);
  });
});
