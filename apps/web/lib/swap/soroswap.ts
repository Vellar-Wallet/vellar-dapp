import type { Network } from "@vellar/types";

// Soroswap venue adapter (docs/design-phase8-payments.md, "Swaps").
//
// Why a Soroban AMM and not the native DEX: a Vellar account is a contract
// (C…). A contract cannot be the source of a classic PathPaymentStrictSend, so
// native-DEX path payments are unreachable from the wallet. Soroswap's router
// is invoked like any other contract, with the wallet's own auth entry, and it
// enforces the slippage floor itself (`amount_out_min`, Error #507).
//
// Quotes come from the router (`router_get_amounts_out`, simulated against
// live pair reserves) — the venue itself, never a price oracle.

// From soroswap/core public/{testnet,mainnet}.contracts.json.
export const SOROSWAP_ROUTER: Record<Network, string> = {
  testnet: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  mainnet: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
};

/** Seconds the router will still accept the swap after it is built. */
export const SWAP_DEADLINE_SECONDS = 300;

/** Default maximum allowed slippage tolerance in basis points (5.00% = 500 bps). */
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;

const BPS_DENOMINATOR = 10_000n;

export interface BuildSwapInput {
  amountIn: bigint;
  minOut: bigint;
  path: string[];
  /** The wallet (C…) — both the payer of amountIn and the receiver of the output. */
  to: string;
  /** Unix seconds. */
  deadline: bigint;
  /**
   * Optional expected output from the initial quote (base units), validated
   * against `minOut` and `maxSlippageBps` before building the transaction.
   */
  expectedOut?: bigint;
  /**
   * Optional maximum allowed slippage tolerance in basis points (1 bps = 0.01%).
   * Overrides the venue-level `maxSlippageBps` (default: 500 bps / 5%).
   */
  maxSlippageBps?: number;
  /**
   * When true, queries live reserves (`router_get_amounts_out`) before building
   * the swap transaction to re-validate slippage against current on-chain state.
   */
  revalidateLiveQuote?: boolean;
}

export interface BuiltSwap {
  /** Assembled, simulated transaction — what kit.sign consumes. */
  tx: unknown;
  /** Per-hop amounts the simulation produced; the last one is the output. */
  simulatedAmounts: bigint[];
}

export type SwapOutcome =
  { status: "success"; amounts: bigint[] } | { status: "failed" } | { status: "unknown" };

export interface SwapVenue {
  name: string;
  router: string;
  getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
  buildSwap(input: BuildSwapInput): Promise<BuiltSwap>;
  readOutcome(hash: string): Promise<SwapOutcome>;
}

const ROUTER_ERRORS: Record<number, string> = {
  503: "The swap's deadline passed before it reached the network.",
  507: "The price moved past your slippage limit, so the swap was refused. Nothing was exchanged.",
  509: "There is no pool for this pair on the venue.",
  510: "Amount is too small for this pool.",
  511: "Not enough liquidity in the pool for that amount.",
  512: "Amount is too small for this pool.",
  513: "Not enough liquidity in the pool for that amount.",
  514: "The venue rejected the route.",
};

export class SwapVenueError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "SwapVenueError";
    this.code = code;
  }
}

export type SlippageErrorReasonCode =
  "SLIPPAGE_TOLERANCE_EXCEEDED" | "STALE_QUOTE_PRICE_MOVED" | "INVALID_SLIPPAGE_BOUNDS";

export class SlippageToleranceError extends SwapVenueError {
  readonly reasonCode: SlippageErrorReasonCode;
  readonly effectiveSlippageBps: number;
  readonly maxSlippageBps: number;
  readonly referenceOut: bigint;
  readonly minOut: bigint;

  constructor(params: {
    reasonCode: SlippageErrorReasonCode;
    message: string;
    effectiveSlippageBps: number;
    maxSlippageBps: number;
    referenceOut: bigint;
    minOut: bigint;
  }) {
    super(params.message, 507);
    this.name = "SlippageToleranceError";
    this.reasonCode = params.reasonCode;
    this.effectiveSlippageBps = params.effectiveSlippageBps;
    this.maxSlippageBps = params.maxSlippageBps;
    this.referenceOut = params.referenceOut;
    this.minOut = params.minOut;
  }
}

/**
 * Compute the effective slippage in basis points between a reference output
 * (`expectedOut` or `liveOut`) and `minOut`, rounding up so tolerance bounds
 * are never understated due to integer division.
 */
export function computeEffectiveSlippageBps(referenceOut: bigint, minOut: bigint): number {
  if (referenceOut <= 0n || minOut <= 0n) {
    throw new SlippageToleranceError({
      reasonCode: "INVALID_SLIPPAGE_BOUNDS",
      message: "Swap output amounts must be positive to validate slippage tolerance.",
      effectiveSlippageBps: Number.POSITIVE_INFINITY,
      maxSlippageBps: 0,
      referenceOut,
      minOut,
    });
  }
  if (minOut > referenceOut) {
    return 0;
  }
  const shortfall = referenceOut - minOut;
  if (shortfall === 0n) return 0;
  return Number((shortfall * BPS_DENOMINATOR + referenceOut - 1n) / referenceOut);
}

/**
 * Validate effective slippage tolerance against `maxSlippageBps` before building
 * a swap transaction. When `liveOut` is provided (from live pool state at build
 * time), re-validates against the live output rather than trusting a stale quote.
 */
export function validateSlippageTolerance(input: {
  referenceOut?: bigint;
  liveOut?: bigint;
  minOut: bigint;
  maxSlippageBps?: number;
}): { effectiveSlippageBps: number; maxSlippageBps: number; baselineOut: bigint } {
  const maxSlippageBps = input.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;
  if (
    !Number.isInteger(maxSlippageBps) ||
    maxSlippageBps < 1 ||
    maxSlippageBps >= Number(BPS_DENOMINATOR)
  ) {
    throw new SlippageToleranceError({
      reasonCode: "INVALID_SLIPPAGE_BOUNDS",
      message: `Maximum slippage bound (${maxSlippageBps} bps) must be an integer between 1 and 9999 bps.`,
      effectiveSlippageBps: 0,
      maxSlippageBps,
      referenceOut: input.liveOut ?? input.referenceOut ?? 0n,
      minOut: input.minOut,
    });
  }

  if (input.minOut <= 0n) {
    throw new SlippageToleranceError({
      reasonCode: "INVALID_SLIPPAGE_BOUNDS",
      message: "Minimum output amount (minOut) must be greater than zero.",
      effectiveSlippageBps: Number.POSITIVE_INFINITY,
      maxSlippageBps,
      referenceOut: input.liveOut ?? input.referenceOut ?? 0n,
      minOut: input.minOut,
    });
  }

  // First check against the quoted expectedOut if provided
  if (input.referenceOut !== undefined) {
    if (input.referenceOut <= 0n || input.minOut > input.referenceOut) {
      throw new SlippageToleranceError({
        reasonCode: "INVALID_SLIPPAGE_BOUNDS",
        message: "Quoted expectedOut must be positive and at least minOut.",
        effectiveSlippageBps: 0,
        maxSlippageBps,
        referenceOut: input.referenceOut,
        minOut: input.minOut,
      });
    }
    const quotedSlippageBps = computeEffectiveSlippageBps(input.referenceOut, input.minOut);
    if (quotedSlippageBps > maxSlippageBps) {
      throw new SlippageToleranceError({
        reasonCode: "SLIPPAGE_TOLERANCE_EXCEEDED",
        message: `Effective slippage tolerance (${quotedSlippageBps} bps) exceeds maximum allowed bound (${maxSlippageBps} bps).`,
        effectiveSlippageBps: quotedSlippageBps,
        maxSlippageBps,
        referenceOut: input.referenceOut,
        minOut: input.minOut,
      });
    }
  }

  // When live pool state is available, re-validate against the live output rather than the stale quote
  if (input.liveOut !== undefined) {
    if (input.liveOut <= 0n) {
      throw new SlippageToleranceError({
        reasonCode: "STALE_QUOTE_PRICE_MOVED",
        message: "Live pool quote returned zero output.",
        effectiveSlippageBps: Number.POSITIVE_INFINITY,
        maxSlippageBps,
        referenceOut: input.liveOut,
        minOut: input.minOut,
      });
    }

    if (input.liveOut < input.minOut) {
      const adverseBps =
        input.referenceOut && input.referenceOut > input.liveOut
          ? computeEffectiveSlippageBps(input.referenceOut, input.liveOut)
          : computeEffectiveSlippageBps(input.minOut, input.liveOut);
      throw new SlippageToleranceError({
        reasonCode: "STALE_QUOTE_PRICE_MOVED",
        message:
          "The price moved past your slippage limit between quote and build time, so the swap was refused.",
        effectiveSlippageBps: adverseBps,
        maxSlippageBps,
        referenceOut: input.liveOut,
        minOut: input.minOut,
      });
    }

    if (input.referenceOut !== undefined && input.liveOut < input.referenceOut) {
      const priceDropBps = computeEffectiveSlippageBps(input.referenceOut, input.liveOut);
      if (priceDropBps > maxSlippageBps) {
        throw new SlippageToleranceError({
          reasonCode: "STALE_QUOTE_PRICE_MOVED",
          message: `Pool price moved by ${priceDropBps} bps since quote time, exceeding maximum slippage bound (${maxSlippageBps} bps).`,
          effectiveSlippageBps: priceDropBps,
          maxSlippageBps,
          referenceOut: input.liveOut,
          minOut: input.minOut,
        });
      }
    }

    const liveEffectiveSlippageBps = computeEffectiveSlippageBps(input.liveOut, input.minOut);
    if (liveEffectiveSlippageBps > maxSlippageBps) {
      throw new SlippageToleranceError({
        reasonCode:
          input.referenceOut !== undefined && input.liveOut !== input.referenceOut
            ? "STALE_QUOTE_PRICE_MOVED"
            : "SLIPPAGE_TOLERANCE_EXCEEDED",
        message: `Effective slippage against live pool state (${liveEffectiveSlippageBps} bps) exceeds maximum allowed bound (${maxSlippageBps} bps).`,
        effectiveSlippageBps: liveEffectiveSlippageBps,
        maxSlippageBps,
        referenceOut: input.liveOut,
        minOut: input.minOut,
      });
    }

    return {
      effectiveSlippageBps: liveEffectiveSlippageBps,
      maxSlippageBps,
      baselineOut: input.liveOut,
    };
  }

  const baselineOut = input.referenceOut ?? input.minOut;
  return {
    effectiveSlippageBps: computeEffectiveSlippageBps(baselineOut, input.minOut),
    maxSlippageBps,
    baselineOut,
  };
}

/** Map a simulation / submission failure to a venue error, keeping the router code. */
export function toVenueError(err: unknown): SwapVenueError {
  if (err instanceof SwapVenueError) return err;
  const text = err instanceof Error ? err.message : String(err);
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  const code = match ? Number(match[1]) : null;
  const known = code !== null ? ROUTER_ERRORS[code] : undefined;
  return new SwapVenueError(known ?? "The swap venue couldn't process this swap.", code);
}

function toBigints(value: unknown): bigint[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "bigint")) {
    throw new SwapVenueError("The swap venue returned an unexpected response.", null);
  }
  return value as bigint[];
}

export function createSoroswapVenue(config: {
  network: Network;
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * Transaction source for simulation. Omit for the smart-wallet path: the
   * sponsor re-envelopes the signed transaction, so the null account is used
   * (a contract cannot source an envelope).
   */
  simulationSource?: string;
  /**
   * Configurable maximum slippage tolerance in basis points (default: 500 bps = 5%).
   * Validated before building the swap transaction.
   */
  maxSlippageBps?: number;
  /**
   * When true, always queries live `router_get_amounts_out` before building the
   * swap transaction to re-validate slippage against current pool reserves.
   */
  revalidateLiveQuote?: boolean;
}): SwapVenue {
  const router = SOROSWAP_ROUTER[config.network];
  const sdk = () => import("@stellar/stellar-sdk");

  async function build(method: string, args: unknown[]) {
    const { contract, scValToNative } = await sdk();
    try {
      return await contract.AssembledTransaction.build({
        contractId: router,
        method,
        args,
        networkPassphrase: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        ...(config.simulationSource && { publicKey: config.simulationSource }),
        parseResultXdr: (v) => toBigints(scValToNative(v)),
      });
    } catch (err) {
      throw toVenueError(err);
    }
  }

  // A failed simulation does not reject build(); it surfaces when the result
  // is read. Read it here so router errors (#507 …) map like any other.
  function resultOf(tx: { result: bigint[] }): bigint[] {
    try {
      return tx.result;
    } catch (err) {
      throw toVenueError(err);
    }
  }

  async function pathArg(path: string[]) {
    const { Address, xdr } = await sdk();
    return xdr.ScVal.scvVec(path.map((id) => new Address(id).toScVal()));
  }

  async function fetchAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]> {
    const { nativeToScVal } = await sdk();
    const tx = await build("router_get_amounts_out", [
      nativeToScVal(amountIn, { type: "i128" }),
      await pathArg(path),
    ]);
    return resultOf(tx);
  }

  return {
    name: "Soroswap",
    router,

    async getAmountsOut(amountIn, path) {
      return fetchAmountsOut(amountIn, path);
    },

    async buildSwap({
      amountIn,
      minOut,
      path,
      to,
      deadline,
      expectedOut,
      maxSlippageBps,
      revalidateLiveQuote,
    }) {
      const effectiveMaxBps = maxSlippageBps ?? config.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;
      const shouldRevalidateLive = revalidateLiveQuote ?? config.revalidateLiveQuote ?? false;

      // 1. Pre-build validation against the quote's expectedOut (fails fast before any RPC call if out of bounds)
      validateSlippageTolerance({
        referenceOut: expectedOut,
        minOut,
        maxSlippageBps: effectiveMaxBps,
      });

      // 2. If live re-validation is enabled, read live pool reserves BEFORE building the swap transaction
      if (shouldRevalidateLive) {
        const liveHopAmounts = await fetchAmountsOut(amountIn, path);
        const liveOut = liveHopAmounts[liveHopAmounts.length - 1];
        validateSlippageTolerance({
          referenceOut: expectedOut,
          liveOut,
          minOut,
          maxSlippageBps: effectiveMaxBps,
        });
      }

      const { Address, nativeToScVal } = await sdk();
      const tx = await build("swap_exact_tokens_for_tokens", [
        nativeToScVal(amountIn, { type: "i128" }),
        nativeToScVal(minOut, { type: "i128" }),
        await pathArg(path),
        new Address(to).toScVal(),
        nativeToScVal(deadline, { type: "u64" }),
      ]);
      const simulatedAmounts = resultOf(tx);
      const simulatedOut = simulatedAmounts[simulatedAmounts.length - 1];

      // 3. Re-validate against the live simulated output produced at build time
      if (simulatedOut !== undefined) {
        validateSlippageTolerance({
          referenceOut: expectedOut,
          liveOut: simulatedOut,
          minOut,
          maxSlippageBps: effectiveMaxBps,
        });
      }

      return { tx, simulatedAmounts };
    },

    async readOutcome(hash) {
      const { rpc, scValToNative } = await sdk();
      const server = new rpc.Server(config.rpcUrl);
      const res = await server.getTransaction(hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return res.returnValue
          ? { status: "success", amounts: toBigints(scValToNative(res.returnValue)) }
          : { status: "unknown" };
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "failed" };
      return { status: "unknown" };
    },
  };
}
