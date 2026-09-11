import { z } from "zod";
import { FacilitatorError } from "./errors";

// Typed HTTP client for vellar-facilitator (new-build-technical-doc.md §4.3).
// The frontend NEVER talks to the facilitator directly — every call goes
// through this client so timeouts, error normalization, and response shape are
// enforced in exactly one place (§4.1).
//
// SHAPE TOLERANCE: the facilitator is a separate repo on its own release
// cadence, and §2.2 documents its endpoints but not its exact field names. The
// schemas below are therefore permissive — unknown keys pass through, and the
// fields we depend on accept the common spellings (price/amount/maxAmountRequired,
// resource/resourceUrl/url). A rename upstream degrades to a missing optional
// rather than a hard 502 on every catalog request.

const looseObject = z.looseObject({});

const amountish = z.union([z.string(), z.number()]).optional();

/** One payment option. The live facilitator serves x402 v2, which nests these
 * inside `accepts[]` rather than at the top level (verified against
 * vellar-facilitator.onrender.com/discovery/resources, 2026-09-12). */
const acceptSchema = z.looseObject({
  scheme: z.string().optional(),
  network: z.string().optional(),
  asset: z.string().optional(),
  amount: amountish,
  maxAmountRequired: amountish,
  price: amountish,
  payTo: z.string().optional(),
  extra: z.looseObject({ areFeesSponsored: z.boolean().optional() }).optional(),
});

/** One catalog entry, normalized to the marketplace resource format (§4.4).
 * Payment fields are read from the first `accepts[]` entry when present and
 * fall back to top-level keys, so both the v2 shape and a flat one work. */
export const resourceSchema = z
  .looseObject({
    resource: z.string().optional(),
    resourceUrl: z.string().optional(),
    url: z.string().optional(),
    scheme: z.string().optional(),
    asset: z.string().optional(),
    network: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    price: amountish,
    amount: amountish,
    maxAmountRequired: amountish,
    accepts: z.array(acceptSchema).optional(),
    lastUpdated: z.union([z.string(), z.number()]).optional(),
  })
  .transform((raw) => {
    const accept = raw.accepts?.[0];
    return {
      resourceUrl: raw.resource ?? raw.resourceUrl ?? raw.url ?? "",
      title: raw.title ?? raw.name,
      description: raw.description,
      scheme: accept?.scheme ?? raw.scheme,
      asset: accept?.asset ?? raw.asset,
      network: accept?.network ?? raw.network,
      priceAtomic: normalizeAmount(
        accept?.amount ??
          accept?.maxAmountRequired ??
          accept?.price ??
          raw.price ??
          raw.amount ??
          raw.maxAmountRequired,
      ),
      payTo: accept?.payTo,
      areFeesSponsored: accept?.extra?.areFeesSponsored,
      lastUpdated: raw.lastUpdated === undefined ? undefined : String(raw.lastUpdated),
      raw: raw as Record<string, unknown>,
    };
  });

export type FacilitatorResource = z.infer<typeof resourceSchema>;

function normalizeAmount(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? String(value) : value;
}

/** The facilitator has used both `items` and `resources` for the list body and
 * both `next`/`nextCursor` for the cursor; accept either without failing. */
const resourceListSchema = z.looseObject({
  items: z.array(resourceSchema).optional(),
  resources: z.array(resourceSchema).optional(),
  data: z.array(resourceSchema).optional(),
  total: z.number().optional(),
  next: z.string().nullish(),
  nextCursor: z.string().nullish(),
});

export interface ResourceListParams {
  scheme?: string;
  asset?: string;
  limit?: number;
  cursor?: string;
}

export interface ResourceListResponse {
  resources: FacilitatorResource[];
  total?: number;
  nextCursor?: string;
}

export interface SearchResponse extends ResourceListResponse {
  query: string;
  /** True when the upstream signalled the result set was truncated or degraded
   * — surfaced so the UI can say "showing partial results" (§4.4). */
  partialResults: boolean;
}

export interface VerifyPayload {
  [key: string]: unknown;
}

export interface SettlePayload {
  [key: string]: unknown;
}

export type VerifyResponse = Record<string, unknown>;
export type SettleResponse = Record<string, unknown>;

export interface FacilitatorClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Test seam: inject a fetch implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** The subset of the client the routes depend on — routes take this interface,
 * so tests can supply a stub without constructing a real HTTP client. */
export interface FacilitatorApi {
  getResources(params: ResourceListParams): Promise<ResourceListResponse>;
  searchResources(query: string, limit?: number): Promise<SearchResponse>;
  getResource(resourceUrl: string): Promise<FacilitatorResource>;
  verify(payload: VerifyPayload): Promise<VerifyResponse>;
  settle(payload: SettlePayload): Promise<SettleResponse>;
}

export class FacilitatorClient implements FacilitatorApi {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FacilitatorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        // Native timeout: a hung facilitator must not hold our connection open
        // for the whole gateway request budget.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Transport failure or timeout — upstreamStatus 0 marks "never answered".
      const reason = err instanceof Error ? err.message : String(err);
      throw new FacilitatorError(0, `Facilitator request failed: ${reason}`, 502);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FacilitatorError(
        response.status,
        `Facilitator responded ${response.status}${body ? `: ${truncate(body)}` : ""}`,
        // 5xx upstream and 4xx upstream both read as 502 to our client: the
        // caller's request to US was valid, the dependency failed.
        502,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new FacilitatorError(response.status, "Facilitator returned a non-JSON body", 502);
    }
  }

  private parseList(payload: unknown): ResourceListResponse {
    const parsed = resourceListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new FacilitatorError(200, "Facilitator returned an unrecognized response shape", 502);
    }
    const { items, resources, data, total, next, nextCursor } = parsed.data;
    return {
      resources: items ?? resources ?? data ?? [],
      total,
      nextCursor: nextCursor ?? next ?? undefined,
    };
  }

  async getResources(params: ResourceListParams): Promise<ResourceListResponse> {
    const query = new URLSearchParams();
    if (params.scheme) query.set("scheme", params.scheme);
    if (params.asset) query.set("asset", params.asset);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    const suffix = query.toString();
    return this.parseList(await this.request(`/discovery/resources${suffix ? `?${suffix}` : ""}`));
  }

  async searchResources(query: string, limit?: number): Promise<SearchResponse> {
    const params = new URLSearchParams({ query });
    if (limit !== undefined) params.set("limit", String(limit));
    const payload = await this.request(`/discovery/search?${params.toString()}`);
    const list = this.parseList(payload);
    const envelope = looseObject.safeParse(payload);
    const partial =
      envelope.success && "partialResults" in envelope.data
        ? Boolean((envelope.data as Record<string, unknown>).partialResults)
        : false;
    return { ...list, query, partialResults: partial };
  }

  /**
   * The facilitator exposes no by-URL detail endpoint (§2.2), so this filters
   * the catalog for an EXACT url match. Exact, never prefix: a caller must not
   * be able to fetch `…/paid` by asking for `…/pai`.
   */
  async getResource(resourceUrl: string): Promise<FacilitatorResource> {
    const { resources } = await this.getResources({ limit: 100 });
    const match = resources.find((r) => r.resourceUrl === resourceUrl);
    if (!match) {
      throw new FacilitatorError(404, `No catalog entry for ${resourceUrl}`, 404, "not_found");
    }
    return match;
  }

  async verify(payload: VerifyPayload): Promise<VerifyResponse> {
    const body = await this.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (body ?? {}) as VerifyResponse;
  }

  async settle(payload: SettlePayload): Promise<SettleResponse> {
    const body = await this.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (body ?? {}) as SettleResponse;
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
