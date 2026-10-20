import type { RegisteredAsset } from "@/lib/assets";

// Pure swap arithmetic. Everything is integer base units (bigint) — no floats
// touch an amount that ends up on-chain.

export const BPS_DENOMINATOR = 10_000n;
/** 0.5% — the default slippage tolerance. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Tolerances outside this range are refused, not clamped. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 500;

export class SwapQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapQuoteError";
  }
}

export interface SwapQuote {
  sell: RegisteredAsset;
  buy: RegisteredAsset;
  /** Exact input, base units. */
  amountIn: bigint;
  /** Venue's expected output for amountIn along `path`, base units. */
  expectedOut: bigint;
  /** Token contract ids, sell first, buy last. */
  path: string[];
  /** Per-hop amounts as returned by the venue (path.length entries). */
  hopAmounts: bigint[];
  /** When the quote was read (ms since epoch). */
  quotedAt: number;
}

export interface SlippageBound {
  slippageBps: number;
  /** Floor of expectedOut × (1 − slippage). Encoded as the router's amount_out_min. */
  minOut: bigint;
}

export function assertSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new SwapQuoteError(
      `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%.`,
    );
  }
}

/** Parse a user-entered percentage ("0.5") into whole basis points. */
export function parseSlippagePercent(input: string): number {
  const trimmed = input.trim();
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new SwapQuoteError("Slippage must be a percentage like 0.5.");
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  assertSlippageBps(bps);
  return bps;
}

export function minimumOut(expectedOut: bigint, slippageBps: number): bigint {
  assertSlippageBps(slippageBps);
  if (expectedOut <= 0n) throw new SwapQuoteError("The venue quoted no output for this amount.");
  const min = (expectedOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  // amount_out_min = 0 would make the router accept ANY output. Never send it.
  if (min <= 0n) throw new SwapQuoteError("Amount is too small to protect against slippage.");
  return min;
}

export function slippageBound(quote: SwapQuote, slippageBps: number): SlippageBound {
  return { slippageBps, minOut: minimumOut(quote.expectedOut, slippageBps) };
}

/** Validate a venue response and turn it into a quote. */
export function normalizeQuote(input: {
  sell: RegisteredAsset;
  buy: RegisteredAsset;
  amountIn: bigint;
  path: string[];
  hopAmounts: readonly bigint[];
  quotedAt: number;
}): SwapQuote {
  const { sell, buy, amountIn, path, hopAmounts } = input;
  if (sell.contractId === buy.contractId) throw new SwapQuoteError("Pick two different assets.");
  if (amountIn <= 0n) throw new SwapQuoteError("Amount must be greater than zero.");
  if (path.length < 2 || path[0] !== sell.contractId || path[path.length - 1] !== buy.contractId) {
    throw new SwapQuoteError("The venue returned a route for different assets.");
  }
  if (hopAmounts.length !== path.length || hopAmounts[0] !== amountIn) {
    throw new SwapQuoteError("The venue returned an inconsistent quote.");
  }
  if (hopAmounts.some((a) => a <= 0n)) {
    throw new SwapQuoteError("Not enough liquidity on this route for that amount.");
  }
  return {
    sell,
    buy,
    amountIn,
    expectedOut: hopAmounts[hopAmounts.length - 1] as bigint,
    path: [...path],
    hopAmounts: [...hopAmounts],
    quotedAt: input.quotedAt,
  };
}

/**
 * Human rate "1 SELL = x BUY" as a decimal string with `precision` digits,
 * computed in integers and truncated (never rounded up in the user's favour).
 */
export function formatRate(
  amountIn: bigint,
  amountOut: bigint,
  sellDecimals: number,
  buyDecimals: number,
  precision = 7,
): string {
  if (amountIn <= 0n) throw new SwapQuoteError("Rate needs a positive input.");
  const scaled =
    (amountOut * 10n ** BigInt(sellDecimals) * 10n ** BigInt(precision)) /
    (amountIn * 10n ** BigInt(buyDecimals));
  const s = scaled.toString().padStart(precision + 1, "0");
  const int = s.slice(0, s.length - precision);
  const frac = s.slice(s.length - precision).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function quotedRate(quote: SwapQuote): string {
  return formatRate(quote.amountIn, quote.expectedOut, quote.sell.decimals, quote.buy.decimals);
}

export function worstCaseRate(quote: SwapQuote, bound: SlippageBound): string {
  return formatRate(quote.amountIn, bound.minOut, quote.sell.decimals, quote.buy.decimals);
}

/** A quote older than this is refused at approval time and must be refreshed. */
export const QUOTE_TTL_MS = 30_000;

export interface QuoteStalenessAssessment {
  isFresh: boolean;
  isStale: boolean;
  ageMs: number;
  maxAgeMs: number;
  remainingMs: number;
  requiresRequote: boolean;
}

export class StaleSwapQuoteError extends SwapQuoteError {
  readonly code = "STALE_SWAP_QUOTE" as const;
  readonly requiresRequote = true as const;
  readonly ageMs: number;
  readonly maxAgeMs: number;
  readonly quotedAt: number;
  readonly evaluatedAt: number;

  constructor(params: { quotedAt: number; evaluatedAt: number; maxAgeMs: number }) {
    const ageMs = params.evaluatedAt - params.quotedAt;
    super(
      `This quote has expired (age ${ageMs}ms exceeds max age ${params.maxAgeMs}ms). Get a fresh quote before approving.`,
    );
    this.name = "StaleSwapQuoteError";
    this.ageMs = ageMs;
    this.maxAgeMs = params.maxAgeMs;
    this.quotedAt = params.quotedAt;
    this.evaluatedAt = params.evaluatedAt;
  }
}

export function assertValidMaxAgeMs(maxAgeMs: number): void {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new SwapQuoteError("Quote max age must be a positive number of milliseconds.");
  }
}

/**
 * Evaluate whether `quote` is still within the allowed `maxAgeMs` window
 * (inclusive of the exact boundary `now - quote.quotedAt === maxAgeMs`).
 */
export function assessQuoteStaleness(
  quote: Pick<SwapQuote, "quotedAt">,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_TTL_MS,
): QuoteStalenessAssessment {
  assertValidMaxAgeMs(maxAgeMs);
  if (!Number.isFinite(quote.quotedAt) || !Number.isFinite(now)) {
    return {
      isFresh: false,
      isStale: true,
      ageMs: Number.POSITIVE_INFINITY,
      maxAgeMs,
      remainingMs: 0,
      requiresRequote: true,
    };
  }
  const ageMs = now - quote.quotedAt;
  const isFresh = ageMs >= 0 && ageMs <= maxAgeMs;
  return {
    isFresh,
    isStale: !isFresh,
    ageMs,
    maxAgeMs,
    remainingMs: isFresh ? maxAgeMs - ageMs : 0,
    requiresRequote: !isFresh,
  };
}

export function isQuoteFresh(
  quote: Pick<SwapQuote, "quotedAt">,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_TTL_MS,
): boolean {
  return assessQuoteStaleness(quote, now, maxAgeMs).isFresh;
}

export function isQuoteStale(
  quote: Pick<SwapQuote, "quotedAt">,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_TTL_MS,
): boolean {
  return !isQuoteFresh(quote, now, maxAgeMs);
}

/**
 * Guard called before building a signable swap transaction. Throws
 * `StaleSwapQuoteError` (with `requiresRequote: true`) if the quote age exceeds
 * `maxAgeMs`.
 */
export function assertQuoteFresh(
  quote: Pick<SwapQuote, "quotedAt">,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_TTL_MS,
): void {
  const assessment = assessQuoteStaleness(quote, now, maxAgeMs);
  if (assessment.isStale) {
    throw new StaleSwapQuoteError({
      quotedAt: quote.quotedAt,
      evaluatedAt: now,
      maxAgeMs,
    });
  }
}

/**
 * Ensure a quote is fresh before building a signable transaction. When the
 * quote is older than `maxAgeMs`, forces a re-quote via `requote()` if provided,
 * or throws `StaleSwapQuoteError`.
 */
export async function ensureFreshQuote<T extends Pick<SwapQuote, "quotedAt">>(
  quote: T,
  options?: {
    now?: number;
    maxAgeMs?: number;
    requote?: () => Promise<T> | T;
  },
): Promise<{ quote: T; wasRefreshed: boolean }> {
  const evaluatedAt = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? QUOTE_TTL_MS;
  if (isQuoteFresh(quote, evaluatedAt, maxAgeMs)) {
    return { quote, wasRefreshed: false };
  }
  if (!options?.requote) {
    throw new StaleSwapQuoteError({
      quotedAt: quote.quotedAt,
      evaluatedAt,
      maxAgeMs,
    });
  }
  const refreshed = await options.requote();
  assertQuoteFresh(refreshed, evaluatedAt, maxAgeMs);
  return { quote: refreshed, wasRefreshed: true };
}
