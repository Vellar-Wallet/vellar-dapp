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
const OFFERS_PAGE_LIMIT = 200;

// Runtime shapes: Horizon is an external service, so its responses are
// VALIDATED, never `as`-cast. A malformed body fails with a clear error here
// rather than a cryptic `.map of undefined` deep in the builder.
const assetRefSchema = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
});

const accountSchema = z.object({
  sequence: z.string(),
  balances: z.array(
    z.object({
      asset_type: z.string(),
      asset_code: z.string().optional(),
      asset_issuer: z.string().optional(),
      balance: z.string(),
    }),
  ),
  data: z.record(z.string(), z.string()).default({}),
});

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

export function createHorizonAccountReader(
  horizonUrl: string,
  options: HorizonReaderOptions = {},
): AccountReader {
  const base = horizonUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOfferPages = options.maxOfferPages ?? DEFAULT_MAX_OFFER_PAGES;
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
      const offers = await fetchAllOffers(accountId);

      return {
        accountId,
        sequence: account.sequence,
        balances: account.balances.map((b) => ({
          assetType: b.asset_type,
          assetCode: b.asset_code,
          assetIssuer: b.asset_issuer,
          balance: b.balance,
        })),
        dataKeys: Object.keys(account.data ?? {}),
        offers,
        openOffers: offers.length,
      };
    },
  };
}
