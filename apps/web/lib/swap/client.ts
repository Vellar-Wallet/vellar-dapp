import type { Network } from "@vellar/types";
import type { PaymentSubmitBackend } from "vellar-sdk";
import { nativeAsset, type RegisteredAsset } from "@/lib/assets";
import {
  isQuoteFresh,
  normalizeQuote,
  quotedRate,
  slippageBound,
  SwapQuoteError,
  worstCaseRate,
  type SwapQuote,
} from "./quote";
import {
  SWAP_DEADLINE_SECONDS,
  SwapVenueError,
  type SwapOutcome,
  type SwapVenue,
} from "./soroswap";

// Swap flow: quote -> explicit review -> passkey sign -> submit -> read the
// on-chain result. Mirrors the send flow (technical-doc.md §7.4): nothing is
// signed until the user confirms the review, and the review shows the exact
// minimum the transaction encodes.

export interface SwapReview {
  from: string;
  network: Network;
  venue: string;
  router: string;
  sell: RegisteredAsset;
  buy: RegisteredAsset;
  amountIn: bigint;
  /** What the transaction simulated to at build time. */
  expectedOut: bigint;
  /** Encoded as the router's amount_out_min — the swap reverts below it. */
  minOut: bigint;
  slippageBps: number;
  /** "1 SELL = x BUY" at expectedOut. */
  rate: string;
  /** "1 SELL = x BUY" at minOut: the worst rate the transaction can execute at. */
  worstRate: string;
  route: RegisteredAsset[];
}

export interface PreparedSwap {
  review: SwapReview;
  /** Sign with the passkey and submit. Only ever call after explicit user approval. */
  confirm(): Promise<{ hash: string }>;
}

export interface SwapSigner {
  sign(tx: unknown): Promise<unknown>;
}

export interface SwapClientDeps {
  venue: SwapVenue;
  kit: SwapSigner;
  backend: PaymentSubmitBackend;
  network: Network;
  signedToXdr: (signed: unknown) => string;
  now?: () => number;
}

export type SwapQuoteSchemaErrorCode =
  | "MISSING_ASSET_PAIR"
  | "MISSING_DESTINATION_AMOUNT"
  | "MALFORMED_QUOTE_RESPONSE"
  | "MISSING_SIMULATED_OUTPUT";

export class SwapQuoteSchemaError extends SwapQuoteError {
  readonly code: SwapQuoteSchemaErrorCode;
  readonly field: string;

  constructor(code: SwapQuoteSchemaErrorCode, field: string, message: string) {
    super(message);
    this.name = "SwapQuoteSchemaError";
    this.code = code;
    this.field = field;
  }
}

function isValidRegisteredAsset(asset: unknown): asset is RegisteredAsset {
  if (typeof asset !== "object" || asset === null) return false;
  const candidate = asset as Partial<RegisteredAsset>;
  return (
    typeof candidate.contractId === "string" &&
    candidate.contractId.trim().length > 0 &&
    typeof candidate.code === "string" &&
    candidate.code.trim().length > 0 &&
    typeof candidate.decimals === "number" &&
    Number.isInteger(candidate.decimals)
  );
}

function coerceBigIntAmount(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new SwapQuoteSchemaError(
    "MISSING_DESTINATION_AMOUNT",
    field,
    `Quote response has an invalid or missing amount in "${field}".`,
  );
}

/**
 * Validate a raw venue quote response (`bigint[]` or object envelope with `amounts` / `hopAmounts`),
 * surfacing a typed `SwapQuoteSchemaError` when expected fields (like destination amount or asset
 * route) are missing while tolerating unexpected extra fields.
 */
export function validateQuoteResponse(
  rawResponse: unknown,
  context: {
    sell: unknown;
    buy: unknown;
    amountIn: bigint;
    path: readonly string[];
  },
): bigint[] {
  if (!isValidRegisteredAsset(context.sell) || !isValidRegisteredAsset(context.buy)) {
    throw new SwapQuoteSchemaError(
      "MISSING_ASSET_PAIR",
      "sell/buy",
      "Quote request or response is missing a valid source/destination asset pair.",
    );
  }

  if (
    !Array.isArray(context.path) ||
    context.path.length < 2 ||
    context.path.some((hop) => typeof hop !== "string" || hop.trim().length === 0)
  ) {
    throw new SwapQuoteSchemaError(
      "MISSING_ASSET_PAIR",
      "path",
      "Quote response is missing a valid asset route path.",
    );
  }

  if (rawResponse === null || rawResponse === undefined) {
    throw new SwapQuoteSchemaError(
      "MALFORMED_QUOTE_RESPONSE",
      "hopAmounts",
      "The venue returned an empty quote response.",
    );
  }

  let rawAmounts: unknown;
  if (Array.isArray(rawResponse)) {
    rawAmounts = rawResponse;
  } else if (typeof rawResponse === "object") {
    // Allow venue envelope objects with extra fields as long as hopAmounts or amounts is present
    const record = rawResponse as Record<string, unknown>;
    if (Array.isArray(record.hopAmounts)) {
      rawAmounts = record.hopAmounts;
    } else if (Array.isArray(record.amounts)) {
      rawAmounts = record.amounts;
    } else {
      throw new SwapQuoteSchemaError(
        "MISSING_DESTINATION_AMOUNT",
        "hopAmounts",
        "Quote response is missing destination hop amounts.",
      );
    }
  } else {
    throw new SwapQuoteSchemaError(
      "MALFORMED_QUOTE_RESPONSE",
      "hopAmounts",
      "Quote response must be an array of hop amounts or a quote object.",
    );
  }

  const list = rawAmounts as unknown[];
  if (list.length < 2 || list[list.length - 1] === undefined || list[list.length - 1] === null) {
    throw new SwapQuoteSchemaError(
      "MISSING_DESTINATION_AMOUNT",
      "expectedOut",
      "Quote response is missing the destination asset amount.",
    );
  }

  return list.map((item, idx) =>
    coerceBigIntAmount(item, idx === list.length - 1 ? "expectedOut" : `hopAmounts[${idx}]`),
  );
}

/**
 * Validate a `SwapQuote` object before transaction preparation, ensuring required
 * asset pair and destination amount fields are present while ignoring extra fields.
 */
export function assertValidSwapQuoteSchema(quote: unknown): asserts quote is SwapQuote {
  if (typeof quote !== "object" || quote === null) {
    throw new SwapQuoteSchemaError(
      "MALFORMED_QUOTE_RESPONSE",
      "quote",
      "Swap quote must be a valid object.",
    );
  }
  const q = quote as Partial<SwapQuote>;
  if (!isValidRegisteredAsset(q.sell) || !isValidRegisteredAsset(q.buy)) {
    throw new SwapQuoteSchemaError(
      "MISSING_ASSET_PAIR",
      "sell/buy",
      "Swap quote is missing source or destination asset metadata.",
    );
  }
  if (
    !Array.isArray(q.path) ||
    q.path.length < 2 ||
    q.path.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    throw new SwapQuoteSchemaError(
      "MISSING_ASSET_PAIR",
      "path",
      "Swap quote is missing a valid asset route.",
    );
  }
  if (
    typeof q.expectedOut !== "bigint" ||
    !Array.isArray(q.hopAmounts) ||
    q.hopAmounts.length < 2
  ) {
    throw new SwapQuoteSchemaError(
      "MISSING_DESTINATION_AMOUNT",
      "expectedOut",
      "Swap quote is missing the destination asset amount.",
    );
  }
  if (typeof q.amountIn !== "bigint") {
    throw new SwapQuoteSchemaError(
      "MALFORMED_QUOTE_RESPONSE",
      "amountIn",
      "Swap quote is missing the input asset amount.",
    );
  }
}

/** Candidate routes: direct, then via XLM when neither side is XLM. */
export function candidatePaths(
  sell: RegisteredAsset,
  buy: RegisteredAsset,
  network: Network,
): string[][] {
  const paths = [[sell.contractId, buy.contractId]];
  const xlm = nativeAsset(network).contractId;
  if (sell.contractId !== xlm && buy.contractId !== xlm) {
    paths.push([sell.contractId, xlm, buy.contractId]);
  }
  return paths;
}

export function createSwapClient(deps: SwapClientDeps) {
  const now = deps.now ?? Date.now;

  return {
    /** Best quote across candidate routes, read from the venue. */
    async quote(input: {
      sell: RegisteredAsset;
      buy: RegisteredAsset;
      amountIn: bigint;
      resolve: (contractId: string) => RegisteredAsset | undefined;
    }): Promise<SwapQuote> {
      const { sell, buy, amountIn } = input;
      if (!isValidRegisteredAsset(sell) || !isValidRegisteredAsset(buy)) {
        throw new SwapQuoteSchemaError(
          "MISSING_ASSET_PAIR",
          "sell/buy",
          "Quote request is missing a valid source or destination asset.",
        );
      }
      if (sell.contractId === buy.contractId)
        throw new SwapQuoteError("Pick two different assets.");
      if (amountIn <= 0n) throw new SwapQuoteError("Amount must be greater than zero.");

      let best: SwapQuote | null = null;
      let lastError: unknown = null;
      for (const path of candidatePaths(sell, buy, deps.network)) {
        try {
          const rawHopAmounts = await deps.venue.getAmountsOut(amountIn, path);
          const hopAmounts = validateQuoteResponse(rawHopAmounts, {
            sell,
            buy,
            amountIn,
            path,
          });
          const quote = normalizeQuote({ sell, buy, amountIn, path, hopAmounts, quotedAt: now() });
          if (!best || quote.expectedOut > best.expectedOut) best = quote;
        } catch (err) {
          lastError = err;
        }
      }
      if (!best) {
        if (lastError instanceof SwapVenueError || lastError instanceof SwapQuoteError) {
          throw lastError;
        }
        throw new SwapQuoteError("No route between these assets on the venue.");
      }
      for (const id of best.path) {
        if (!input.resolve(id))
          throw new SwapQuoteError("The venue routed through an unknown asset.");
      }
      return best;
    },

    /**
     * Build + simulate the swap with the slippage floor encoded. Throws if the
     * quote is stale or if the simulated output is already below the floor.
     */
    async prepare(input: {
      from: string;
      quote: SwapQuote;
      slippageBps: number;
      resolve: (contractId: string) => RegisteredAsset | undefined;
    }): Promise<PreparedSwap> {
      const { quote, from } = input;
      assertValidSwapQuoteSchema(quote);
      if (!isQuoteFresh(quote, now())) {
        throw new SwapQuoteError("This quote has expired. Get a fresh quote before approving.");
      }
      const bound = slippageBound(quote, input.slippageBps);
      const deadline = BigInt(Math.floor(now() / 1000) + SWAP_DEADLINE_SECONDS);

      const built = await deps.venue.buildSwap({
        amountIn: quote.amountIn,
        minOut: bound.minOut,
        path: quote.path,
        to: from,
        deadline,
      });

      if (!built || !Array.isArray(built.simulatedAmounts) || built.simulatedAmounts.length < 2) {
        throw new SwapQuoteSchemaError(
          "MISSING_SIMULATED_OUTPUT",
          "simulatedAmounts",
          "Swap simulation response is missing the destination asset amount.",
        );
      }

      const simulatedOut = built.simulatedAmounts[built.simulatedAmounts.length - 1];
      if (simulatedOut === undefined || typeof simulatedOut !== "bigint") {
        throw new SwapQuoteSchemaError(
          "MISSING_SIMULATED_OUTPUT",
          "simulatedAmounts",
          "Swap simulation response is missing a valid destination output amount.",
        );
      }
      if (simulatedOut < bound.minOut) {
        // The router would revert on-chain anyway; fail before asking for a signature.
        throw new SwapVenueError(
          "The price moved past your slippage limit, so the swap was refused. Nothing was exchanged.",
          507,
        );
      }

      const route = quote.path.map((id) => input.resolve(id));
      if (route.some((a) => a === undefined)) {
        throw new SwapQuoteError("The venue routed through an unknown asset.");
      }

      const review: SwapReview = {
        from,
        network: deps.network,
        venue: deps.venue.name,
        router: deps.venue.router,
        sell: quote.sell,
        buy: quote.buy,
        amountIn: quote.amountIn,
        expectedOut: simulatedOut,
        minOut: bound.minOut,
        slippageBps: bound.slippageBps,
        rate: quotedRate({ ...quote, expectedOut: simulatedOut }),
        worstRate: worstCaseRate(quote, bound),
        route: route as RegisteredAsset[],
      };

      return {
        review,
        async confirm() {
          const signed = await deps.kit.sign(built.tx);
          return deps.backend.submitTransaction({
            signedXdr: deps.signedToXdr(signed),
            network: deps.network,
          });
        },
      };
    },

    readOutcome(hash: string): Promise<SwapOutcome> {
      return deps.venue.readOutcome(hash);
    },
  };
}

export type SwapClient = ReturnType<typeof createSwapClient>;
