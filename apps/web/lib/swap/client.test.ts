// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { assetsFor, findAssetByContractId, type RegisteredAsset } from "@/lib/assets";
import { candidatePaths, createSwapClient } from "./client";
import { SwapQuoteError } from "./quote";
import { SwapVenueError, toVenueError, type SwapVenue } from "./soroswap";

const [XLM, USDC] = assetsFor("testnet") as [RegisteredAsset, RegisteredAsset];
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const resolve = (id: string) => findAssetByContractId("testnet", id);

function venue(overrides: Partial<SwapVenue> = {}): SwapVenue {
  return {
    name: "Soroswap",
    router: "CROUTER",
    getAmountsOut: vi.fn(async (amountIn: bigint) => [amountIn, (amountIn * 105n) / 1000n]),
    buildSwap: vi.fn(async ({ amountIn }) => ({
      tx: { kind: "assembled" },
      simulatedAmounts: [amountIn, (amountIn * 105n) / 1000n],
    })),
    readOutcome: vi.fn(async () => ({ status: "success" as const, amounts: [1n, 2n] })),
    ...overrides,
  };
}

function client(v: SwapVenue, now = () => 10_000) {
  const kit = { sign: vi.fn(async (tx: unknown) => ({ signed: tx })) };
  const backend = { submitTransaction: vi.fn(async () => ({ hash: "swaphash" })) };
  const signedToXdr = vi.fn(() => "SIGNED_XDR");
  return {
    kit,
    backend,
    signedToXdr,
    swaps: createSwapClient({ venue: v, kit, backend, network: "testnet", signedToXdr, now }),
  };
}

describe("candidatePaths", () => {
  it("routes directly when one side is XLM", () => {
    expect(candidatePaths(XLM, USDC, "testnet")).toEqual([[XLM.contractId, USDC.contractId]]);
  });

  it("adds a hop through XLM when neither side is XLM", () => {
    const other = { ...USDC, id: "EURC:x", contractId: "CEURC" };
    expect(candidatePaths(USDC, other, "testnet")).toEqual([
      [USDC.contractId, other.contractId],
      [USDC.contractId, XLM.contractId, other.contractId],
    ]);
  });
});

describe("swap client", () => {
  it("quotes from the venue itself", async () => {
    const v = venue();
    const q = await client(v).swaps.quote({
      sell: XLM,
      buy: USDC,
      amountIn: 100_000_000n,
      resolve,
    });
    expect(v.getAmountsOut).toHaveBeenCalledWith(100_000_000n, [XLM.contractId, USDC.contractId]);
    expect(q.expectedOut).toBe(10_500_000n);
  });

  it("surfaces the venue's error when no route quotes", async () => {
    const v = venue({
      getAmountsOut: vi.fn(async () => {
        throw toVenueError(new Error("HostError: Error(Contract, #509)"));
      }),
    });
    await expect(
      client(v).swaps.quote({ sell: XLM, buy: USDC, amountIn: 1n, resolve }),
    ).rejects.toThrow(/no pool/);
  });

  it("encodes the slippage floor as amount_out_min and builds for the wallet", async () => {
    const v = venue();
    const { swaps } = client(v);
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 100_000_000n, resolve });
    const prepared = await swaps.prepare({ from: WALLET, quote, slippageBps: 100, resolve });

    expect(v.buildSwap).toHaveBeenCalledWith({
      amountIn: 100_000_000n,
      minOut: 10_395_000n, // 10_500_000 × 0.99
      slippageBps: 100,
      path: [XLM.contractId, USDC.contractId],
      to: WALLET,
      deadline: 310n, // floor(10_000 ms / 1000) + 300 s
    });
    expect(prepared.review).toMatchObject({
      from: WALLET,
      sell: XLM,
      buy: USDC,
      amountIn: 100_000_000n,
      expectedOut: 10_500_000n,
      minOut: 10_395_000n,
      slippageBps: 100,
      rate: "0.105",
      worstRate: "0.10395",
      route: [XLM, USDC],
      venue: "Soroswap",
    });
  });

  it("does not sign or submit until confirm() is called", async () => {
    const { swaps, kit, backend } = client(venue());
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });
    const prepared = await swaps.prepare({ from: WALLET, quote, slippageBps: 50, resolve });
    expect(kit.sign).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();

    await expect(prepared.confirm()).resolves.toEqual({ hash: "swaphash" });
    expect(kit.sign).toHaveBeenCalledWith({ kind: "assembled" });
    expect(backend.submitTransaction).toHaveBeenCalledWith({
      signedXdr: "SIGNED_XDR",
      network: "testnet",
    });
  });

  it("refuses to prepare when the simulation already lands below the floor", async () => {
    const v = venue({
      // Price moved between quote and build: output collapsed.
      buildSwap: vi.fn(async ({ amountIn }) => ({
        tx: {},
        simulatedAmounts: [amountIn, 1n],
      })),
    });
    const { swaps, kit } = client(v);
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });
    await expect(swaps.prepare({ from: WALLET, quote, slippageBps: 50, resolve })).rejects.toThrow(
      /slippage/,
    );
    expect(kit.sign).not.toHaveBeenCalled();
  });

  it("maps a router slippage revert during simulation to a clear error", async () => {
    const v = venue({
      buildSwap: vi.fn(async () => {
        throw toVenueError(new Error("simulation failed: Error(Contract, #507)"));
      }),
    });
    const { swaps } = client(v);
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });
    const err = await swaps
      .prepare({ from: WALLET, quote, slippageBps: 50, resolve })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapVenueError);
    expect((err as SwapVenueError).code).toBe(507);
  });

  it("refuses a stale quote", async () => {
    let t = 0;
    const { swaps } = client(venue(), () => t);
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });
    t = 31_000;
    await expect(swaps.prepare({ from: WALLET, quote, slippageBps: 50, resolve })).rejects.toThrow(
      /expired/,
    );
  });

  it("forces a re-quote when the quote exceeds the configured max age", async () => {
    let t = 0;
    const kit = { sign: vi.fn(async (tx: unknown) => ({ signed: tx })) };
    const backend = { submitTransaction: vi.fn(async () => ({ hash: "swaphash" })) };
    const swaps = createSwapClient({
      venue: venue(),
      kit,
      backend,
      network: "testnet",
      signedToXdr: () => "SIGNED_XDR",
      now: () => t,
      maxQuoteAgeMs: 5_000,
    });

    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve });

    // Exactly at the boundary age: still signable.
    t = 5_000;
    const prepared = await swaps.prepare({ from: WALLET, quote, slippageBps: 50, resolve });
    expect(prepared.review.minOut).toBeGreaterThan(0n);

    // One millisecond past it: refused, and nothing is signed.
    t = 5_001;
    await expect(
      swaps.prepare({ from: WALLET, quote, slippageBps: 50, resolve }),
    ).rejects.toThrow(/expired/);
    expect(kit.sign).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
  });

  it("surfaces a typed error when the quote response is missing the destination amount", async () => {
    const v = venue({
      // Destination asset amount absent: the response has no output to use.
      getAmountsOut: vi.fn(async (amountIn: bigint) => [amountIn] as bigint[]),
    });
    const err = await client(v)
      .swaps.quote({ sell: XLM, buy: USDC, amountIn: 100_000_000n, resolve })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SwapQuoteError);
    expect((err as Error).message).toMatch(/inconsistent/i);
  });

  it("surfaces a typed error rather than undefined when a hop amount is not a bigint", async () => {
    const v = venue({
      // The destination amount slot is present but empty — what a partial
      // decode of a malformed response looks like.
      getAmountsOut: vi.fn(async (amountIn: bigint) => [amountIn, undefined] as unknown as bigint[]),
    });
    const err = await client(v)
      .swaps.quote({ sell: XLM, buy: USDC, amountIn: 100_000_000n, resolve })
      .then(() => null, (e: unknown) => e);
    // Must be a typed quote error, not a TypeError from comparing a hole
    // against a bigint — a downstream consumer catches SwapQuoteError.
    expect(err).toBeInstanceOf(SwapQuoteError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/unexpected response/i);
  });

  it("parses a quote response that carries an unexpected extra field", async () => {
    const hopAmounts = [100_000_000n, 10_500_000n] as bigint[] & { extra?: string };
    hopAmounts.extra = "not part of the schema";
    const v = venue({ getAmountsOut: vi.fn(async () => hopAmounts) });
    const q = await client(v).swaps.quote({
      sell: XLM,
      buy: USDC,
      amountIn: 100_000_000n,
      resolve,
    });
    expect(q.expectedOut).toBe(10_500_000n);
    expect(q.hopAmounts).toEqual([100_000_000n, 10_500_000n]);
  });

  it("rejects routes through assets outside the registry", async () => {
    const v = venue();
    const { swaps } = client(v);
    await expect(
      swaps.quote({ sell: XLM, buy: USDC, amountIn: 10n ** 7n, resolve: () => undefined }),
    ).rejects.toThrow(/unknown asset/);
  });

  it("rejects out-of-range slippage before building", async () => {
    const v = venue();
    const { swaps } = client(v);
    const quote = await swaps.quote({ sell: XLM, buy: USDC, amountIn: 10n ** 7n, resolve });
    await expect(swaps.prepare({ from: WALLET, quote, slippageBps: 0, resolve })).rejects.toThrow();
    await expect(
      swaps.prepare({ from: WALLET, quote, slippageBps: 5000, resolve }),
    ).rejects.toThrow();
    expect(v.buildSwap).not.toHaveBeenCalled();
  });
});

describe("toVenueError", () => {
  it.each([
    [507, /slippage/],
    [503, /deadline/],
    [511, /liquidity/],
  ])("maps router error #%i", (code, message) => {
    const err = toVenueError(new Error(`HostError: Error(Contract, #${code})`));
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
  });

  it("falls back without leaking raw diagnostics", () => {
    const err = toVenueError(new Error("secret internal trace"));
    expect(err.code).toBeNull();
    expect(err.message).not.toMatch(/secret/);
  });
});
