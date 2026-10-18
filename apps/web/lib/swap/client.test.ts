// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { assetsFor, findAssetByContractId, type RegisteredAsset } from "@/lib/assets";
import {
  SwapQuoteSchemaError,
  assertValidSwapQuoteSchema,
  candidatePaths,
  createSwapClient,
  validateQuoteResponse,
} from "./client";
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

describe("quote response schema validation (#556)", () => {
  it("surfaces SwapQuoteSchemaError with MISSING_DESTINATION_AMOUNT when destination amount is missing", async () => {
    const vMissingOut = venue({
      // Only 1 hop returned — destination asset amount is missing
      getAmountsOut: vi.fn(async (amountIn: bigint) => [amountIn]),
    });
    const { swaps } = client(vMissingOut);

    await expect(
      swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve }),
    ).rejects.toThrowError(SwapQuoteSchemaError);

    await expect(
      swaps.quote({ sell: XLM, buy: USDC, amountIn: 10_000_000n, resolve }),
    ).rejects.toMatchObject({
      name: "SwapQuoteSchemaError",
      code: "MISSING_DESTINATION_AMOUNT",
      field: "expectedOut",
    });

    // Also rejects prepare() if a quote object is missing expectedOut
    const validQuote = await client(venue()).swaps.quote({
      sell: XLM,
      buy: USDC,
      amountIn: 10_000_000n,
      resolve,
    });
    const brokenQuote = { ...validQuote, expectedOut: undefined } as unknown as typeof validQuote;
    await expect(
      swaps.prepare({ from: WALLET, quote: brokenQuote, slippageBps: 50, resolve }),
    ).rejects.toMatchObject({
      name: "SwapQuoteSchemaError",
      code: "MISSING_DESTINATION_AMOUNT",
    });
  });

  it("surfaces SwapQuoteSchemaError with MISSING_ASSET_PAIR when source/destination asset pair or path is missing", async () => {
    const { swaps } = client(venue());

    await expect(
      swaps.quote({
        sell: undefined as unknown as RegisteredAsset,
        buy: USDC,
        amountIn: 10_000_000n,
        resolve,
      }),
    ).rejects.toMatchObject({
      name: "SwapQuoteSchemaError",
      code: "MISSING_ASSET_PAIR",
      field: "sell/buy",
    });

    await expect(
      swaps.quote({
        sell: { ...XLM, contractId: "" },
        buy: USDC,
        amountIn: 10_000_000n,
        resolve,
      }),
    ).rejects.toMatchObject({
      name: "SwapQuoteSchemaError",
      code: "MISSING_ASSET_PAIR",
      field: "sell/buy",
    });

    expect(() =>
      assertValidSwapQuoteSchema({
        sell: XLM,
        buy: USDC,
        amountIn: 100n,
        expectedOut: 10n,
        path: [XLM.contractId],
        hopAmounts: [100n, 10n],
        quotedAt: 1000,
      }),
    ).toThrowError(SwapQuoteSchemaError);
  });

  it("allows unexpected extra fields on quote and simulation responses without breaking parsing", async () => {
    const vWithExtras = venue({
      // Venue returns an envelope object with unexpected extra fields
      getAmountsOut: vi.fn(
        async (amountIn: bigint) =>
          ({
            amounts: [amountIn, (amountIn * 105n) / 1000n],
            aggregatorVersion: "v2.4.1",
            priceImpactBps: 12,
            routeMetadata: { poolId: "CPOOL123", feeBps: 30 },
          }) as unknown as bigint[],
      ),
      buildSwap: vi.fn(async ({ amountIn }) => ({
        tx: { kind: "assembled", extraTxMeta: "ignored" },
        simulatedAmounts: [amountIn, (amountIn * 105n) / 1000n],
        extraSimulationTrace: { cpuInsns: 123456 },
      })),
    });

    const { swaps } = client(vWithExtras);
    const quote = await swaps.quote({
      sell: XLM,
      buy: USDC,
      amountIn: 100_000_000n,
      resolve,
    });
    expect(quote.expectedOut).toBe(10_500_000n);

    // Attach extra fields to the SwapQuote object before calling prepare()
    const quoteWithExtras = {
      ...quote,
      quoteId: "q-999",
      experimentalDiagnostics: { latencyMs: 42 },
    } as typeof quote;

    const prepared = await swaps.prepare({
      from: WALLET,
      quote: quoteWithExtras,
      slippageBps: 100,
      resolve,
    });
    expect(prepared.review.expectedOut).toBe(10_500_000n);
    expect(prepared.review.minOut).toBe(10_395_000n);

    // Direct validateQuoteResponse call with extra fields and stringified integer amounts
    const validated = validateQuoteResponse(
      {
        hopAmounts: ["100000000", "10500000"],
        unexpectedField: true,
        nestedExtra: { a: 1 },
      },
      {
        sell: XLM,
        buy: USDC,
        amountIn: 100_000_000n,
        path: [XLM.contractId, USDC.contractId],
      },
    );
    expect(validated).toEqual([100_000_000n, 10_500_000n]);
  });
});
