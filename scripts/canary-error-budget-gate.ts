#!/usr/bin/env tsx
/**
 * Canary error-budget gate (#336).
 *
 * Scrapes a service's real `/metrics` endpoint (registered by
 * `@vellar/service-kit`'s `registerMetrics` — `vela_http_requests_total`,
 * labeled by `status`) twice, `--window-ms` apart, and computes the 5xx
 * error rate **within that window** (a delta between the two snapshots, not
 * a lifetime average — so a canary that's been up for hours and had one
 * blip long ago isn't penalized forever). Exits non-zero if the rate
 * exceeds `--max-error-rate` or if too few requests were observed to judge
 * (avoids a false "healthy" verdict from near-zero traffic).
 *
 * As with deploy-health-gate.ts: this does not perform an actual
 * percentage-based traffic split — see that script's doc comment for why
 * (no orchestrator in this repo yet). This is the automatable half of the
 * canary workflow: an error-budget check to gate a MANUAL promote/rollback
 * decision on, using metrics the service already emits for real.
 *
 * Usage:
 *   tsx scripts/canary-error-budget-gate.ts --url https://canary.api-gateway.example
 *   tsx scripts/canary-error-budget-gate.ts --url http://localhost:4000 --window-ms 60000 --max-error-rate 0.01 --min-requests 20
 *
 * Exit codes:
 *   0 — error rate within budget (or too few requests occurred — see stdout; still exit 0, since "no traffic yet" isn't a failure signal, just inconclusive)
 *   1 — error rate exceeded --max-error-rate
 *   2 — invalid arguments or the /metrics endpoint could not be scraped
 */

export interface CanaryGateOptions {
  /** Base URL of the service; /metrics is appended. */
  url: string;
  /** How long to wait between the two scrapes, in ms. Default 60_000 (1 minute). */
  windowMs?: number;
  /** Reject if the 5xx rate over the window exceeds this fraction. Default 0.02 (2%). */
  maxErrorRate?: number;
  /** Minimum total requests observed in the window to render a verdict at all. Default 10. */
  minRequests?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface RequestCounts {
  total: number;
  serverErrors: number;
}

export interface CanaryGateResult {
  ok: boolean;
  /** True when too few requests occurred to compute a meaningful rate. */
  inconclusive: boolean;
  requestsInWindow: number;
  serverErrorsInWindow: number;
  errorRate: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ERROR_RATE = 0.02;
const DEFAULT_MIN_REQUESTS = 10;

/**
 * Parse `vela_http_requests_total{...,status="..."} <value>` lines out of a
 * Prometheus text-format scrape. Deliberately minimal (this repo's metrics
 * exposition is entirely first-party via prom-client, so the format is
 * stable) rather than pulling in a full Prometheus text-format parser
 * dependency for one counter family.
 */
export function parseRequestCounts(prometheusText: string): RequestCounts {
  let total = 0;
  let serverErrors = 0;

  for (const line of prometheusText.split("\n")) {
    if (!line.startsWith("vela_http_requests_total{")) continue;
    const match = /^vela_http_requests_total\{([^}]*)\}\s+(\d+(?:\.\d+)?)/.exec(line);
    if (!match) continue;
    const [, labelsRaw, valueRaw] = match;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;

    total += value;

    const statusMatch = /status="(\d+)"/.exec(labelsRaw ?? "");
    const status = statusMatch?.[1];
    if (status && status.length === 3 && status.startsWith("5")) {
      serverErrors += value;
    }
  }

  return { total, serverErrors };
}

async function scrape(url: string, fetchImpl: typeof fetch): Promise<RequestCounts> {
  const response = await fetchImpl(`${url.replace(/\/$/, "")}/metrics`);
  if (!response.ok) {
    throw new Error(`/metrics returned HTTP ${response.status}`);
  }
  return parseRequestCounts(await response.text());
}

export async function runCanaryGate(options: CanaryGateOptions): Promise<CanaryGateResult> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxErrorRate = options.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const minRequests = options.minRequests ?? DEFAULT_MIN_REQUESTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const before = await scrape(options.url, fetchImpl);
  await sleepImpl(windowMs);
  const after = await scrape(options.url, fetchImpl);

  // Counters only increase, so a delta below zero means the process
  // restarted (counters reset) between scrapes — treat the "after" snapshot
  // as the whole window in that case rather than producing a negative count.
  const requestsInWindow = after.total >= before.total ? after.total - before.total : after.total;
  const serverErrorsInWindow =
    after.serverErrors >= before.serverErrors
      ? after.serverErrors - before.serverErrors
      : after.serverErrors;

  const inconclusive = requestsInWindow < minRequests;
  const errorRate = requestsInWindow > 0 ? serverErrorsInWindow / requestsInWindow : 0;

  return {
    ok: inconclusive || errorRate <= maxErrorRate,
    inconclusive,
    requestsInWindow,
    serverErrorsInWindow,
    errorRate,
  };
}

function parseArgs(argv: string[]): CanaryGateOptions | { error: string } {
  let url: string | undefined;
  let windowMs: number | undefined;
  let maxErrorRate: number | undefined;
  let minRequests: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--url":
        url = next();
        break;
      case "--window-ms":
        windowMs = Number(next());
        break;
      case "--max-error-rate":
        maxErrorRate = Number(next());
        break;
      case "--min-requests":
        minRequests = Number(next());
        break;
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }

  if (!url) return { error: "--url is required" };
  if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs < 1)) {
    return { error: "--window-ms must be a positive number" };
  }
  if (maxErrorRate !== undefined && (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate > 1)) {
    return { error: "--max-error-rate must be between 0 and 1" };
  }
  if (minRequests !== undefined && (!Number.isInteger(minRequests) || minRequests < 0)) {
    return { error: "--min-requests must be a non-negative integer" };
  }

  return { url, windowMs, maxErrorRate, minRequests };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    console.error(
      "Usage: tsx scripts/canary-error-budget-gate.ts --url <base-url> [--window-ms N] [--max-error-rate 0.02] [--min-requests N]",
    );
    process.exit(2);
  }

  console.log(
    `Watching ${parsed.url}/metrics for ${(parsed.windowMs ?? DEFAULT_WINDOW_MS) / 1000}s (max error rate ${(parsed.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE) * 100}%)...`,
  );

  try {
    const result = await runCanaryGate(parsed);

    if (result.inconclusive) {
      console.log(
        `Inconclusive: only ${result.requestsInWindow} requests observed (need ${parsed.minRequests ?? DEFAULT_MIN_REQUESTS}). Not enough traffic yet to judge the canary — wait and re-run before promoting.`,
      );
      process.exit(0);
    }

    console.log(
      `${result.serverErrorsInWindow}/${result.requestsInWindow} requests were 5xx (${(result.errorRate * 100).toFixed(2)}%).`,
    );

    if (result.ok) {
      console.log("✓ Within error budget. Safe to promote the canary.");
      process.exit(0);
    } else {
      console.error("✗ Error budget exceeded. Roll back the canary — do not promote.");
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: could not scrape ${parsed.url}/metrics — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
