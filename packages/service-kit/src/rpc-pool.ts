// Soroban RPC endpoint pool with health-check rotation.
//
// Every backend service used to pin exactly one STELLAR_RPC_URL, so a single
// provider outage (or a provider that stays "up" but stops ingesting ledgers)
// took down every RPC-dependent path at once. This pool holds an ordered list
// of endpoints and decides which one callers should use right now:
//
//   - ACTIVE probing: on an interval, every endpoint is sent a JSON-RPC
//     `getHealth`. An endpoint is healthy when it answers within the timeout,
//     reports status "healthy", and its latestLedger is within
//     `maxLedgerLag` of the freshest ledger any endpoint reported — a
//     provider that answers but has fallen behind is as bad as one that's
//     down (stale reads, bad sequence numbers, simulation against old state).
//   - PASSIVE reports: callers `reportFailure(url)` when a real call against
//     an endpoint fails at the transport level, which demotes it immediately
//     instead of waiting for the next probe. The next successful probe
//     restores it.
//
// Selection is priority-ordered, not round-robin: the first healthy endpoint
// in the configured order wins, so traffic returns to the primary as soon as
// it recovers. When nothing is healthy the pool still hands out an endpoint
// (least-recently-failed first) rather than throwing — a stale health view
// must never be the reason a call isn't even attempted.
//
// Dependency-free (plain fetch, no @stellar/stellar-sdk), in the same
// explicit-clock style as circuit-breaker.ts, so every service can use it.

export interface RpcEndpointHealth {
  url: string;
  healthy: boolean;
  /** latestLedger from the last successful probe, if any. */
  latestLedger?: number;
  /** Why the endpoint is unhealthy (probe error, lag, passive failure). */
  reason?: string;
  lastCheckedAt?: number;
  /** When the endpoint was last marked unhealthy (probe or passive). */
  lastFailureAt?: number;
}

export interface RpcProbeResult {
  status: string;
  latestLedger: number;
}

/** Probes one endpoint. Resolves with its reported health; rejects on any
 * transport, timeout, or JSON-RPC error. */
export type RpcProbe = (url: string, timeoutMs: number) => Promise<RpcProbeResult>;

export interface RpcPoolOptions {
  /** Ordered by priority — the first is the preferred (primary) endpoint. */
  urls: string[];
  /** How often to probe every endpoint. Default 30s. */
  intervalMs?: number;
  /** Per-probe timeout. Default 5s. */
  timeoutMs?: number;
  /** Max ledgers an endpoint may trail the freshest endpoint and still count
   * as healthy. Default 10 (~50s at 5s close time). */
  maxLedgerLag?: number;
  /** Injected for tests; defaults to a fetch-based JSON-RPC getHealth. */
  probe?: RpcProbe;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Called whenever the selected endpoint changes. */
  onRotate?: (from: string, to: string, reason: string) => void;
  /** Called with each endpoint's state after every probe cycle. */
  onProbe?: (health: RpcEndpointHealth[]) => void;
}

export interface RpcPool {
  /** The endpoint callers should use right now. */
  current(): string;
  /** Every endpoint in the order callers should try them: healthy ones in
   * priority order, then unhealthy ones least-recently-failed first. */
  candidates(): string[];
  /** Demote an endpoint after a real call against it failed at the transport
   * level. Unknown URLs are ignored. */
  reportFailure(url: string, reason?: string): void;
  /** Probe every endpoint now and update health. Never rejects. */
  checkNow(): Promise<RpcEndpointHealth[]>;
  /** Start periodic probing (runs one probe immediately). Idempotent. */
  start(): void;
  stop(): void;
  snapshot(): RpcEndpointHealth[];
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LEDGER_LAG = 10;

/** The real probe: a JSON-RPC `getHealth` call over fetch. */
export const getHealthProbe: RpcProbe = async (url, timeoutMs) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: { status?: unknown; latestLedger?: unknown };
    error?: { message?: unknown };
  };
  if (body.error) {
    throw new Error(`getHealth error: ${String(body.error.message ?? "unknown")}`);
  }
  const status = body.result?.status;
  const latestLedger = body.result?.latestLedger;
  if (typeof status !== "string" || typeof latestLedger !== "number") {
    throw new Error("getHealth returned a malformed result");
  }
  return { status, latestLedger };
};

export function createRpcPool(options: RpcPoolOptions): RpcPool {
  const urls = dedupe(options.urls);
  if (urls.length === 0) {
    throw new Error("createRpcPool: at least one RPC URL is required");
  }
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLedgerLag = options.maxLedgerLag ?? DEFAULT_MAX_LEDGER_LAG;
  const probe = options.probe ?? getHealthProbe;
  const now = options.now ?? Date.now;

  // Every endpoint starts healthy: before the first probe completes there is
  // no evidence against any of them, and the primary should be used.
  const state = new Map<string, RpcEndpointHealth>(
    urls.map((url) => [url, { url, healthy: true }]),
  );
  let selected = urls[0]!;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<RpcEndpointHealth[]> | undefined;

  function candidates(): string[] {
    const healthy = urls.filter((url) => state.get(url)!.healthy);
    const unhealthy = urls
      .filter((url) => !state.get(url)!.healthy)
      .sort((a, b) => (state.get(a)!.lastFailureAt ?? 0) - (state.get(b)!.lastFailureAt ?? 0));
    return [...healthy, ...unhealthy];
  }

  function reselect(reason: string) {
    const next = candidates()[0]!;
    if (next !== selected) {
      const from = selected;
      selected = next;
      options.onRotate?.(from, next, reason);
    }
  }

  function markUnhealthy(url: string, reason: string) {
    const entry = state.get(url);
    if (!entry) return;
    entry.healthy = false;
    entry.reason = reason;
    entry.lastFailureAt = now();
  }

  async function runProbes(): Promise<RpcEndpointHealth[]> {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          return { url, result: await probe(url, timeoutMs) };
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    const freshest = Math.max(
      0,
      ...results.flatMap((r) => (r.result ? [r.result.latestLedger] : [])),
    );
    const checkedAt = now();

    for (const r of results) {
      const entry = state.get(r.url)!;
      entry.lastCheckedAt = checkedAt;
      if (!r.result) {
        markUnhealthy(r.url, `probe failed: ${r.error}`);
        continue;
      }
      entry.latestLedger = r.result.latestLedger;
      if (r.result.status !== "healthy") {
        markUnhealthy(r.url, `reported status "${r.result.status}"`);
      } else if (freshest - r.result.latestLedger > maxLedgerLag) {
        markUnhealthy(
          r.url,
          `lagging ${freshest - r.result.latestLedger} ledgers behind the freshest endpoint`,
        );
      } else {
        entry.healthy = true;
        entry.reason = undefined;
      }
    }

    reselect("health check");
    const health = snapshot();
    options.onProbe?.(health);
    return health;
  }

  function snapshot(): RpcEndpointHealth[] {
    return urls.map((url) => ({ ...state.get(url)! }));
  }

  return {
    current: () => selected,
    candidates,
    snapshot,

    reportFailure(url, reason = "call failed") {
      if (!state.has(url)) return;
      markUnhealthy(url, reason);
      reselect(`${url}: ${reason}`);
    },

    checkNow() {
      // Coalesce overlapping probe cycles (a slow cycle must not stack up
      // behind the interval).
      inFlight ??= runProbes().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    start() {
      if (timer) return;
      void this.checkNow();
      timer = setInterval(() => void this.checkNow(), intervalMs);
      // Never keep the process alive just to probe RPC.
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Run `fn` against the pool's endpoints in candidate order, moving to the next
 * one when `fn` throws an error `isFailover` classifies as an endpoint problem
 * (default: every error). The failing endpoint is reported to the pool. Only
 * use this for calls that are safe to repeat on another endpoint (reads,
 * simulations, re-sending the same signed transaction).
 */
export async function withRpcFailover<T>(
  pool: RpcPool,
  fn: (url: string) => Promise<T>,
  isFailover: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (const url of pool.candidates()) {
    try {
      return await fn(url);
    } catch (err) {
      if (!isFailover(err)) throw err;
      lastError = err;
      pool.reportFailure(url, err instanceof Error ? err.message : String(err));
    }
  }
  throw lastError;
}

export interface RpcPoolEnv {
  urls: string[];
  intervalMs: number;
  timeoutMs: number;
  maxLedgerLag: number;
}

/**
 * Read the RPC endpoint list from env: STELLAR_RPC_URLS (comma-separated,
 * priority order) wins; otherwise the single STELLAR_RPC_URL; otherwise
 * `fallbackUrl`. Tuning: STELLAR_RPC_HEALTH_INTERVAL_MS,
 * STELLAR_RPC_HEALTH_TIMEOUT_MS, STELLAR_RPC_MAX_LEDGER_LAG.
 */
export function rpcPoolConfigFromEnv(
  fallbackUrl: string,
  env: Record<string, string | undefined> = process.env,
): RpcPoolEnv {
  const list = (env.STELLAR_RPC_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const urls = list.length > 0 ? dedupe(list) : [env.STELLAR_RPC_URL || fallbackUrl];
  return {
    urls,
    intervalMs: positiveOr(env.STELLAR_RPC_HEALTH_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    timeoutMs: positiveOr(env.STELLAR_RPC_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxLedgerLag: positiveOr(env.STELLAR_RPC_MAX_LEDGER_LAG, DEFAULT_MAX_LEDGER_LAG),
  };
}

function positiveOr(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
