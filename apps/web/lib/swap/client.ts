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
  /** How long a quote may be signed after it was fetched. Defaults to QUOTE_TTL_MS. */
  maxQuoteAgeMs?: number;
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
      if (sell.contractId === buy.contractId)
        throw new SwapQuoteError("Pick two different assets.");
      if (amountIn <= 0n) throw new SwapQuoteError("Amount must be greater than zero.");

      let best: SwapQuote | null = null;
      let lastError: unknown = null;
      for (const path of candidatePaths(sell, buy, deps.network)) {
        try {
          const hopAmounts = await deps.venue.getAmountsOut(amountIn, path);
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
      if (!isQuoteFresh(quote, now(), deps.maxQuoteAgeMs)) {
        throw new SwapQuoteError("This quote has expired. Get a fresh quote before approving.");
      }
      const bound = slippageBound(quote, input.slippageBps);
      const deadline = BigInt(Math.floor(now() / 1000) + SWAP_DEADLINE_SECONDS);

      const built = await deps.venue.buildSwap({
        amountIn: quote.amountIn,
        minOut: bound.minOut,
        slippageBps: bound.slippageBps,
        path: quote.path,
        to: from,
        deadline,
      });

      const simulatedOut = built.simulatedAmounts[built.simulatedAmounts.length - 1];
      if (simulatedOut === undefined || simulatedOut < bound.minOut) {
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
