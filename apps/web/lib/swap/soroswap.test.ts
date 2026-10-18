// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_SLIPPAGE_BPS,
  SlippageToleranceError,
  computeEffectiveSlippageBps,
  createSoroswapVenue,
  validateSlippageTolerance,
} from "./soroswap";

const buildMock = vi.fn();

vi.mock("@stellar/stellar-sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    contract: {
      ...actual.contract,
      AssembledTransaction: {
        build: (...args: unknown[]) => buildMock(...args),
      },
    },
  };
});

const XLM_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const WALLET = XLM_CONTRACT;

describe("soroswap slippage-tolerance validation (#554)", () => {
  beforeEach(() => {
    buildMock.mockReset();
  });

  it("computes effective slippage in basis points and rounds up fractional bps", () => {
    expect(computeEffectiveSlippageBps(10_000n, 10_000n)).toBe(0);
    expect(computeEffectiveSlippageBps(10_000n, 9_950n)).toBe(50);
    expect(computeEffectiveSlippageBps(10_000n, 9_500n)).toBe(500);
    // 1 unit below 100_000 is 0.1 bps -> rounds up to 1 bps so tolerance is never understated
    expect(computeEffectiveSlippageBps(100_000n, 99_999n)).toBe(1);
  });

  it("accepts slippage at or below the configurable maximum bound and rejects when exceeded", () => {
    const valid = validateSlippageTolerance({
      referenceOut: 10_000n,
      minOut: 9_800n, // 200 bps (2%)
      maxSlippageBps: 200,
    });
    expect(valid).toEqual({
      effectiveSlippageBps: 200,
      maxSlippageBps: 200,
      baselineOut: 10_000n,
    });

    expect(() =>
      validateSlippageTolerance({
        referenceOut: 10_000n,
        minOut: 9_799n, // 201 bps > 200 bps max
        maxSlippageBps: 200,
      }),
    ).toThrowError(SlippageToleranceError);

    try {
      validateSlippageTolerance({
        referenceOut: 10_000n,
        minOut: 9_400n, // 600 bps > DEFAULT_MAX_SLIPPAGE_BPS (500)
      });
      expect.unreachable("should have thrown SlippageToleranceError");
    } catch (err) {
      expect(err).toBeInstanceOf(SlippageToleranceError);
      expect(err).toMatchObject({
        name: "SlippageToleranceError",
        code: 507,
        reasonCode: "SLIPPAGE_TOLERANCE_EXCEEDED",
        effectiveSlippageBps: 600,
        maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
        referenceOut: 10_000n,
        minOut: 9_400n,
      });
    }
  });

  it("rejects building the swap transaction before invoking the router when slippage exceeds maxSlippageBps", async () => {
    const venue = createSoroswapVenue({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      maxSlippageBps: 300, // 3% max bound
    });

    await expect(
      venue.buildSwap({
        amountIn: 100_000_000n,
        expectedOut: 10_000_000n,
        minOut: 9_600_000n, // 400 bps (4%) > 300 bps max
        path: [XLM_CONTRACT, USDC_CONTRACT],
        to: WALLET,
        deadline: 1_700_000_000n,
      }),
    ).rejects.toMatchObject({
      name: "SlippageToleranceError",
      reasonCode: "SLIPPAGE_TOLERANCE_EXCEEDED",
      effectiveSlippageBps: 400,
      maxSlippageBps: 300,
    });

    // Must reject BEFORE building the swap transaction on the router
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("re-validates against live pool state when a quote becomes stale (adverse price movement) before building", async () => {
    // Live router_get_amounts_out returns a lower output (9_650_000n: 350 bps drop from 10_000_000n)
    buildMock.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "router_get_amounts_out") {
        return { result: [100_000_000n, 9_650_000n] };
      }
      return { result: [100_000_000n, 9_650_000n] };
    });

    const venue = createSoroswapVenue({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      maxSlippageBps: 200, // 2% max bound
      revalidateLiveQuote: true,
    });

    // Original quote had expectedOut = 10_000_000n and minOut = 9_900_000n (100 bps, valid against original quote).
    // However, live state moved to 9_650_000n before build time.
    await expect(
      venue.buildSwap({
        amountIn: 100_000_000n,
        expectedOut: 10_000_000n,
        minOut: 9_900_000n,
        path: [XLM_CONTRACT, USDC_CONTRACT],
        to: WALLET,
        deadline: 1_700_000_000n,
      }),
    ).rejects.toMatchObject({
      name: "SlippageToleranceError",
      reasonCode: "STALE_QUOTE_PRICE_MOVED",
      maxSlippageBps: 200,
      referenceOut: 9_650_000n,
      minOut: 9_900_000n,
    });

    // Only router_get_amounts_out was queried; swap_exact_tokens_for_tokens was never built
    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(buildMock.mock.calls[0]?.[0]?.method).toBe("router_get_amounts_out");
  });

  it("re-validates against live state when price moves up so the stale minOut now exceeds maxSlippageBps against live reserves", async () => {
    // Original quote was 10_000_000n with minOut = 9_700_000n (300 bps <= 500 bps max).
    // Between quote and build time, live pool output moved to 11_000_000n.
    // Against the live state (11_000_000n), minOut (9_700_000n) leaves 1,182 bps (> 500 bps) of slippage exposure!
    buildMock.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "router_get_amounts_out") {
        return { result: [100_000_000n, 11_000_000n] };
      }
      return { result: [100_000_000n, 11_000_000n] };
    });

    const venue = createSoroswapVenue({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      maxSlippageBps: 500,
      revalidateLiveQuote: true,
    });

    await expect(
      venue.buildSwap({
        amountIn: 100_000_000n,
        expectedOut: 10_000_000n,
        minOut: 9_700_000n,
        path: [XLM_CONTRACT, USDC_CONTRACT],
        to: WALLET,
        deadline: 1_700_000_000n,
      }),
    ).rejects.toMatchObject({
      name: "SlippageToleranceError",
      reasonCode: "STALE_QUOTE_PRICE_MOVED",
      maxSlippageBps: 500,
      referenceOut: 11_000_000n,
      minOut: 9_700_000n,
    });

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(buildMock.mock.calls[0]?.[0]?.method).toBe("router_get_amounts_out");
  });

  it("builds the swap transaction when both quoted and live outputs are within maxSlippageBps", async () => {
    buildMock.mockImplementation(async () => ({
      result: [100_000_000n, 9_950_000n],
    }));

    const venue = createSoroswapVenue({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      maxSlippageBps: 200,
      revalidateLiveQuote: true,
    });

    const built = await venue.buildSwap({
      amountIn: 100_000_000n,
      expectedOut: 10_000_000n,
      minOut: 9_900_000n, // 100 bps against quote, ~51 bps against live 9_950_000n
      path: [XLM_CONTRACT, USDC_CONTRACT],
      to: WALLET,
      deadline: 1_700_000_000n,
    });

    expect(built.simulatedAmounts).toEqual([100_000_000n, 9_950_000n]);
    expect(buildMock).toHaveBeenCalledTimes(2);
    expect(buildMock.mock.calls[0]?.[0]?.method).toBe("router_get_amounts_out");
    expect(buildMock.mock.calls[1]?.[0]?.method).toBe("swap_exact_tokens_for_tokens");
  });
});
