import { z } from "zod";
import { retryWithBackoff } from "@vellar/service-kit";

// Horizon account reader seam (technical-doc.md §6.3 Lifecycle Service:
// account inspection). Classic (G...) accounts only — cleanup/merge is a
// classic-account concept; smart wallets are contracts and cannot be merged.

export interface HorizonBalance {
  assetType: string; // "native" | "credit_alphanum4" | "credit_alphanum12" | ...
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
}

export interface HorizonOffer {
  id: string;
  sellingAssetType: string;
  sellingAssetCode?: string;
  sellingAssetIssuer?: string;
  buyingAssetType: string;
  buyingAssetCode?: string;
  buyingAssetIssuer?: string;
  price: string;
}

export interface HorizonAccount {
  accountId: string;
  /** Current sequence number (needed to build transactions). */
  sequence: string;
  balances: HorizonBalance[];
  /** Managed-data entry keys. */
  dataKeys: string[];
  offers: HorizonOffer[];
  openOffers: number;
  /** False when trustline or offer pagination was cut short (#531). */
  paginationComplete?: boolean;
  /** Reason pagination was cut short, if any (#531). */
  paginationError?: string;
}

export class HorizonPaginationError extends Error {
  readonly code:
    "trustline_pagination_failed" | "trustline_pagination_truncated" | "offer_pagination_failed";
  readonly partialCount: number;

  constructor(
    message: string,
    opts: {
      code:
        | "trustline_pagination_failed"
        | "trustline_pagination_truncated"
        | "offer_pagination_failed";
      partialCount: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HorizonPaginationError";
    this.code = opts.code;
    this.partialCount = opts.partialCount;
  }
}

/**
 * Safety check that refuses to proceed with cleanup plan construction if
 * Horizon trustline/offer pagination did not complete cleanly (#531).
 */
export function assertCompleteAccountPagination(account: HorizonAccount): void {
  if (account.paginationComplete === false || account.paginationError) {
    throw new HorizonPaginationError(
      `Refusing to build cleanup plan for ${account.accountId}: Horizon pagination was cut short (${account.paginationError ?? "incomplete trustline pages"}).`,
      {
        code: "trustline_pagination_failed",
        partialCount: account.balances.length,
      },
    );
  }
}

export interface AccountReader {
  /** undefined = account does not exist on the network. */
  getAccount(accountId: string): Promise<HorizonAccount | undefined>;
}

/** The narrow slice of `fetch` this reader uses: a string URL plus an abort
 * signal. Narrower than the DOM `fetch` type so test doubles stay simple. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface HorizonReaderOptions {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Per-request timeout; a hung Horizon must not stall the service. */
  timeoutMs?: number;
  /** Safety cap on offer pages followed, so a misbehaving `next` can't loop
   * forever (200 offers/page ⇒ 50 pages = 10k offers, far past any real account). */
  maxOfferPages?: number;
  /** Page size threshold for trustline pagination (#531). Defaults to 200. */
  trustlinePageSize?: number;
  /** Safety cap on trustline pages followed (#531). Defaults to 50. */
  maxTrustlinePages?: number;
  /** Retry options for transient Horizon failures (5xx, network errors).
   * 404s and validation errors are never retried. Defaults: 3 attempts,
   * 200 ms base delay, 5 s ceiling. Pass `{ maxAttempts: 1 }` to disable. */
  retryOptions?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OFFER_PAGES = 50;
const DEFAULT_MAX_TRUSTLINE_PAGES = 50;
const OFFERS_PAGE_LIMIT = 200;
export const TRUSTLINES_PAGE_LIMIT = 200;

// Runtime shapes: Horizon is an external service, so its responses are
// VALIDATED, never `as`-cast. A malformed body fails with a clear error here
// rather than a cryptic `.map of undefined` deep in the builder.
const assetRefSchema = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
});

const balanceRecordSchema = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: z.string(),
});

const nextLinkSchema = z.object({ href: z.string() }).optional();

const accountSchema = z.object({
  sequence: z.string(),
  balances: z.array(balanceRecordSchema),
  data: z.record(z.string(), z.string()).default({}),
  _links: z
    .object({
      next: nextLinkSchema,
      trustlines: nextLinkSchema,
      balances: nextLinkSchema,
    })
    .optional(),
});

const trustlinesPageSchema = z.union([
  z.object({
    _links: z.object({ next: nextLinkSchema }).optional(),
    _embedded: z.object({ records: z.array(balanceRecordSchema) }),
  }),
  z.object({
    _links: z.object({ next: nextLinkSchema }).optional(),
    balances: z.array(balanceRecordSchema),
  }),
]);

const offerRecordSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  selling: assetRefSchema,
  buying: assetRefSchema,
  price: z.string(),
});

const offersPageSchema = z.object({
  _links: z.object({ next: z.object({ href: z.string() }).optional() }).optional(),
  _embedded: z.object({ records: z.array(offerRecordSchema) }),
});

function balanceKey(b: HorizonBalance): string {
  return b.assetType === "native"
    ? "native"
    : `${b.assetType}:${b.assetCode ?? ""}:${b.assetIssuer ?? ""}`;
}

function toHorizonBalance(b: z.infer<typeof balanceRecordSchema>): HorizonBalance {
  return {
    assetType: b.asset_type,
    assetCode: b.asset_code,
    assetIssuer: b.asset_issuer,
    balance: b.balance,
  };
}

export function createHorizonAccountReader(
  horizonUrl: string,
  options: HorizonReaderOptions = {},
): AccountReader {
  const base = horizonUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOfferPages = options.maxOfferPages ?? DEFAULT_MAX_OFFER_PAGES;
  const trustlinePageSize = options.trustlinePageSize ?? TRUSTLINES_PAGE_LIMIT;
  const maxTrustlinePages = options.maxTrustlinePages ?? DEFAULT_MAX_TRUSTLINE_PAGES;
  const retryOpts = {
    maxAttempts: options.retryOptions?.maxAttempts ?? 3,
    baseDelayMs: options.retryOptions?.baseDelayMs ?? 200,
    maxDelayMs: options.retryOptions?.maxDelayMs ?? 5_000,
  };

  /** Fetch JSON with a timeout; caller validates the shape.
   * 5xx responses and network errors are retried with exponential back-off.
   * 404s are returned immediately (the account does not exist — not transient). */
  async function fetchJson(url: string, label: string): Promise<{ status: number; body: unknown }> {
    return retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await doFetch(url, { signal: controller.signal });
          if (res.status === 404) return { status: 404, body: undefined };
          if (!res.ok) throw new Error(`Horizon ${label} failed (${res.status})`);
          return { status: res.status, body: await res.json() };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        ...retryOpts,
        // 404 responses never come back as errors — they're returned as a
        // { status: 404 } value, so isRetryable only sees genuine throw-paths
        // (non-ok status, network error, abort). Non-retriable: 400-level
        // responses that signal a permanent client mistake. Retry everything
        // else (5xx, AbortError / network error).
        isRetryable: (err) => {
          if (err instanceof Error && err.name === "AbortError") return false;
          return true;
        },
      },
    );
  }

  async function fetchAdditionalTrustlines(
    accountId: string,
    initialBalances: HorizonBalance[],
    initialNextHref?: string,
  ): Promise<HorizonBalance[]> {
    const balances = [...initialBalances];
    const seen = new Set<string>(balances.map(balanceKey));
    const nonNativeCount = balances.filter((b) => b.assetType !== "native").length;

    let nextUrl =
      initialNextHref && initialNextHref.length > 0
        ? initialNextHref
        : nonNativeCount >= trustlinePageSize
          ? `${base}/accounts/${encodeURIComponent(accountId)}/trustlines?limit=${trustlinePageSize}`
          : undefined;

    if (!nextUrl) {
      return balances;
    }

    const visitedUrls = new Set<string>();
    for (let page = 0; page < maxTrustlinePages; page++) {
      if (visitedUrls.has(nextUrl)) {
        break;
      }
      visitedUrls.add(nextUrl);

      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await fetchJson(nextUrl, "trustlines fetch"));
      } catch (err) {
        throw new HorizonPaginationError(
          `Horizon trustline pagination failed partway through for ${accountId} (after ${balances.length} balance entries): ${(err as Error).message}`,
          {
            code: "trustline_pagination_failed",
            partialCount: balances.length,
            cause: err,
          },
        );
      }

      if (status === 404) {
        throw new HorizonPaginationError(
          `Horizon trustline pagination failed partway through for ${accountId}: page returned 404`,
          {
            code: "trustline_pagination_failed",
            partialCount: balances.length,
          },
        );
      }

      const parsed = trustlinesPageSchema.safeParse(body);
      if (!parsed.success) {
        throw new HorizonPaginationError(
          `Horizon trustlines response was malformed: ${parsed.error.message}`,
          {
            code: "trustline_pagination_failed",
            partialCount: balances.length,
          },
        );
      }

      const rawRecords =
        "_embedded" in parsed.data ? parsed.data._embedded.records : parsed.data.balances;
      if (rawRecords.length === 0) {
        break;
      }

      let addedOnPage = 0;
      for (const raw of rawRecords) {
        const mapped = toHorizonBalance(raw);
        const key = balanceKey(mapped);
        if (!seen.has(key)) {
          seen.add(key);
          balances.push(mapped);
          addedOnPage++;
        }
      }

      const next = parsed.data._links?.next?.href;
      if (!next || addedOnPage === 0) {
        break;
      }

      if (page === maxTrustlinePages - 1) {
        throw new HorizonPaginationError(
          `Horizon trustline pagination exceeded maxTrustlinePages (${maxTrustlinePages}) for ${accountId}; refusing to return truncated trustline set`,
          {
            code: "trustline_pagination_truncated",
            partialCount: balances.length,
          },
        );
      }

      nextUrl = next;
    }

    return balances;
  }

  async function fetchAllOffers(accountId: string): Promise<HorizonOffer[]> {
    let url = `${base}/accounts/${encodeURIComponent(accountId)}/offers?limit=${OFFERS_PAGE_LIMIT}`;
    const offers: HorizonOffer[] = [];
    for (let page = 0; page < maxOfferPages; page++) {
      const { body } = await fetchJson(url, "offers fetch");
      const parsed = offersPageSchema.safeParse(body);
      if (!parsed.success)
        throw new Error(`Horizon offers response was malformed: ${parsed.error.message}`);
      const records = parsed.data._embedded.records;
      // An empty page ends pagination even if a `next` link is still advertised
      // (Horizon's next always points one past the last record).
      if (records.length === 0) break;
      for (const o of records) {
        offers.push({
          id: o.id,
          sellingAssetType: o.selling.asset_type,
          sellingAssetCode: o.selling.asset_code,
          sellingAssetIssuer: o.selling.asset_issuer,
          buyingAssetType: o.buying.asset_type,
          buyingAssetCode: o.buying.asset_code,
          buyingAssetIssuer: o.buying.asset_issuer,
          price: o.price,
        });
      }
      const next = parsed.data._links?.next?.href;
      if (!next) break; // no further pages
      url = next;
    }
    return offers;
  }

  return {
    async getAccount(accountId) {
      const { status, body } = await fetchJson(
        `${base}/accounts/${encodeURIComponent(accountId)}`,
        "account fetch",
      );
      if (status === 404) return undefined;

      const parsed = accountSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error(`Horizon account response was malformed: ${parsed.error.message}`);
      }
      const account = parsed.data;
      const initialBalances = account.balances.map(toHorizonBalance);
      const initialNextHref =
        account._links?.trustlines?.href ||
        account._links?.balances?.href ||
        account._links?.next?.href;
      const balances = await fetchAdditionalTrustlines(accountId, initialBalances, initialNextHref);
      const offers = await fetchAllOffers(accountId);

      return {
        accountId,
        sequence: account.sequence,
        balances,
        dataKeys: Object.keys(account.data ?? {}),
        offers,
        openOffers: offers.length,
      };
    },
  };
}
