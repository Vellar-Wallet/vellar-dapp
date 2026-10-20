// In-memory Idempotency-Key store (issue #260), matching the existing
// in-memory TokenBucketLimiter pattern in this gateway (token-bucket.ts).
//
// Known limitation, disclosed rather than silently accepted: this is
// per-process state. A multi-instance deployment of api-gateway (more than
// one replica behind a load balancer) would NOT share idempotency records
// across instances, so a retry that happens to land on a different replica
// would not be deduplicated. Fine for the current single-instance
// deployment target; a real production multi-replica deployment needs this
// backed by Redis or another shared store instead. Not built here since
// nothing else in this gateway has a shared-state dependency yet, and adding
// one is a bigger, separate infrastructure decision than this issue's own
// scope.
//
// NOT YET WIRED INTO THE PROXY — see docs/api-versioning.md or the PR body
// for #260 for why: buffering a proxied @fastify/http-proxy response to
// cache it requires intercepting `res.stream` in replyOptions.onResponse,
// and @fastify/http-proxy@11's own type definitions do not type that
// callback or its `res` parameter at all (checked
// node_modules/@fastify/http-proxy/types/index.d.ts directly), so a real
// implementation would be working against an effectively-`any` stream
// object with no compiler safety net, and the actual `undici` dispatch
// handler shape it's built on is not part of this package's exported types
// either. This store class itself is complete and would-be-correct
// dedupe/conflict logic; wiring it into the actual proxy response path is
// left for a follow-up once the stream-interception approach is designed
// and verified against a real @fastify/http-proxy response, not guessed at.

//Per-route TTL rationale (#544):
// Different gateway routes front operations with very different lifecycles and
// replay-safety requirements:
//   - `/policies` (`/v1/policies`) — 48h (172_800_000 ms): Policy deployment
//     and constructor attachment involve sponsor-funded Soroban contract
//     creation plus asynchronous DLQ/retry workers. Client or worker retries
//     after an RPC outage can arrive hours later; a long TTL prevents deploying
//     duplicate policy contracts for the same wallet.
//   - `/verification` (`/v1/verification`) — 24h (86_400_000 ms): Deterministic
//     WASM verification builds and x402 payment settlements are expensive,
//     long-running jobs where duplicate submissions should replay the existing
//     job outcome across a full day.
//   - `/lifecycle` (`/v1/lifecycle`) — 15m (900_000 ms): Signed Soroban
//     transaction execution envelopes carry ledger timebounds (typically <=60s)
//     and sequence numbers; retries are only meaningful within the short
//     submission/settlement window.
//   - `/wallet` (`/v1/wallet`) — 5m (300_000 ms): Ephemeral challenge/connect
//     and fee-sponsorship requests have a 60s transaction timebound ceiling,
//     so stale keys can age out quickly to bound memory growth.

export const DEFAULT_GLOBAL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export const DEFAULT_ROUTE_IDEMPOTENCY_TTL_MS: Readonly<Record<string, number>> = Object.freeze({
  "/policies": 48 * 60 * 60 * 1000, // 48h — multi-step contract deployment + async worker retries
  "/verification": 24 * 60 * 60 * 1000, // 24h — long-running hermetic WASM build jobs
  "/lifecycle": 15 * 60 * 1000, // 15m — bounded by Soroban tx timebounds & x402 settlement
  "/wallet": 5 * 60 * 1000, // 5m — short-lived challenge/connect & sponsor envelopes
});

export interface IdempotencyRecord {
  /** SHA-256 hex digest of the request body, so a differing payload under
   * the same key is detectable rather than silently served the cached
   * response. */
  payloadHash: string;
  statusCode: number;
  /** Response headers worth replaying verbatim on a cache hit. Only a small
   * allowlist, not everything Fastify sent (e.g. never Content-Length: the
   * cached body's length; recomputed by Fastify on send instead of trusted
   * from the first response). */
  headers: Record<string, string>;
  body: string;
  recordedAt: number;
  /** Optional route path or prefix (e.g. "/policies/deploy" or "/v1/policies/deploy")
   * used to resolve the per-route TTL override (#544). */
  route?: string;
  /** Optional explicit TTL override (ms) for this specific record. */
  ttlMs?: number;
}

export interface IdempotencyStoreOptions {
  /** Global fallback TTL in milliseconds when no route override matches. Default: 24h. */
  ttlMs?: number;
  /** Per-route or per-prefix TTL overrides in milliseconds (e.g. `{ "/policies": 172_800_000 }`). */
  routeTtlMs?: Record<string, number>;
}

export type IdempotencyLookupResult =
  { kind: "miss" } | { kind: "hit"; record: IdempotencyRecord } | { kind: "conflict" };

function normalizeRouteKey(route: string): string {
  const withoutQuery = route.split("?")[0]!.trim();
  if (!withoutQuery.startsWith("/")) return `/${withoutQuery}`;
  return withoutQuery.length > 1 && withoutQuery.endsWith("/")
    ? withoutQuery.slice(0, -1)
    : withoutQuery;
}

function stripVersionPrefix(route: string): string {
  if (route === "/v1") return "/";
  return route.startsWith("/v1/") ? route.slice(3) : route;
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly routeTtlMs: Map<string, number>;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_GLOBAL_IDEMPOTENCY_TTL_MS;
    this.routeTtlMs = new Map<string, number>();

    if (options.routeTtlMs) {
      for (const [route, ttl] of Object.entries(options.routeTtlMs)) {
        if (Number.isFinite(ttl) && ttl > 0) {
          this.routeTtlMs.set(normalizeRouteKey(route), ttl);
        }
      }
    }
  }

  /**
   * Resolves the effective TTL (ms) for a given route path by checking:
   * 1. Exact route match (or `/v1`-stripped equivalent)
   * 2. Longest matching route prefix (e.g. `/policies` for `/v1/policies/deploy`)
   * 3. The store's global default `ttlMs`
   */
  resolveTtlMs(route?: string): number {
    if (!route || this.routeTtlMs.size === 0) return this.ttlMs;

    const normalized = normalizeRouteKey(route);
    const unversioned = stripVersionPrefix(normalized);

    const exact = this.routeTtlMs.get(normalized) ?? this.routeTtlMs.get(unversioned);
    if (exact !== undefined) return exact;

    let bestMatchLength = -1;
    let bestTtl: number | undefined;

    for (const [configuredPrefix, ttl] of this.routeTtlMs.entries()) {
      const candidates = [configuredPrefix, stripVersionPrefix(configuredPrefix)];
      for (const candidate of candidates) {
        if (
          (normalized === candidate ||
            normalized.startsWith(`${candidate}/`) ||
            unversioned === candidate ||
            unversioned.startsWith(`${candidate}/`)) &&
          candidate.length > bestMatchLength
        ) {
          bestMatchLength = candidate.length;
          bestTtl = ttl;
        }
      }
    }

    return bestTtl ?? this.ttlMs;
  }

  private isExpired(record: IdempotencyRecord, now: number, routeOverride?: string): boolean {
    const effectiveTtlMs =
      record.ttlMs !== undefined && Number.isFinite(record.ttlMs) && record.ttlMs > 0
        ? record.ttlMs
        : this.resolveTtlMs(routeOverride ?? record.route);
    return now - record.recordedAt > effectiveTtlMs;
  }

  /** Looks up a key against the payload it would be used with THIS time.
   * "conflict" means the key was already used with a DIFFERENT payload —
   * per the issue's own requirement, this must never silently serve one
   * request's cached response to a different request's caller. */
  lookup(
    key: string,
    payloadHash: string,
    now = Date.now(),
    route?: string,
  ): IdempotencyLookupResult {
    const record = this.records.get(key);
    if (!record || this.isExpired(record, now, route)) return { kind: "miss" };
    if (record.payloadHash !== payloadHash) return { kind: "conflict" };
    return { kind: "hit", record };
  }

  record(key: string, record: IdempotencyRecord, route?: string): void {
    const storedRecord = route && !record.route ? { ...record, route } : record;
    this.records.set(key, storedRecord);
  }

  /** Periodic cleanup so long-running processes don't accumulate expired
   * entries forever. Not called automatically; callers wire it into their
   * own interval per their own deployment's tolerance for memory growth. */
  pruneExpired(now = Date.now()): number {
    let pruned = 0;
    for (const [key, record] of this.records) {
      if (this.isExpired(record, now)) {
        this.records.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /** Test/inspection seam only. */
  get size(): number {
    return this.records.size;
  }
}
