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
  /** Route this record was recorded under, used to pick the per-route TTL
   * override when one is configured. Absent means the global default applies. */
  route?: string;
}

export type IdempotencyLookupResult =
  | { kind: "miss" }
  | { kind: "hit"; record: IdempotencyRecord }
  | { kind: "conflict" };

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly routeTtlMs: Record<string, number>;

  /** Routes that need a longer idempotency window than the global default:
   *
   * - `POST /policies/deploy` — a policy deployment is a multi-step,
   *   potentially slow on-chain operation. A client retry hours later must
   *   still deduplicate against the original deployment rather than
   *   starting a second one.
   * - `POST /lifecycle/execute` — same reasoning: a paid, long-running
   *   execution whose settlement can take minutes to hours.
   *
   * Routes with short, repeatable reads (e.g. `GET /wallet/balance`) do not
   * need an override — the global default is already generous for them.
   */
  constructor(
    options: {
      ttlMs?: number;
      /** Per-route TTL overrides in ms, keyed by the route string stored on
       * each record. Falls back to the global `ttlMs` (default 24h). */
      routeTtlMs?: Record<string, number>;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000; // 24h default
    this.routeTtlMs = options.routeTtlMs ?? {};
  }

  private ttlFor(route: string | undefined): number {
    return (route !== undefined ? this.routeTtlMs[route] : undefined) ?? this.ttlMs;
  }

  private isExpired(record: IdempotencyRecord, now: number): boolean {
    return now - record.recordedAt > this.ttlFor(record.route);
  }

  /** Looks up a key against the payload it would be used with THIS time.
   * "conflict" means the key was already used with a DIFFERENT payload —
   * per the issue's own requirement, this must never silently serve one
   * request's cached response to a different request's caller. */
  lookup(key: string, payloadHash: string, now = Date.now()): IdempotencyLookupResult {
    const record = this.records.get(key);
    if (!record || this.isExpired(record, now)) return { kind: "miss" };
    if (record.payloadHash !== payloadHash) return { kind: "conflict" };
    return { kind: "hit", record };
  }

  record(key: string, record: IdempotencyRecord): void {
    this.records.set(key, record);
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
