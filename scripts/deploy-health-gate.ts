#!/usr/bin/env tsx
/**
 * Deploy health gate (#334, #336).
 *
 * Polls a service's /health endpoint and exits 0 only once it has answered
 * healthy for `--consecutive` checks in a row within `--timeout-ms` — the
 * gate a blue/green cutover (#334) or canary promotion (#336) should run
 * before routing real traffic to a new deployment, or before declaring an
 * old environment safe to tear down.
 *
 * This does NOT perform an actual traffic cutover or percentage-based
 * canary split — this project deploys as a single combined process to
 * Railway/Render (see railway.json, render.yaml), which have no built-in
 * blue/green or canary primitive, and there is no orchestrator (k8s/ECS) in
 * this repo to drive one (see infra/README.md's `k8s/` note — aspirational,
 * not yet built). What this script gives you is the real, usable half of
 * that workflow on this infra: an automatable, scriptable readiness check
 * to gate a MANUAL promotion/rollback decision (or a CI step) on, instead of
 * eyeballing a dashboard or guessing how long to wait after a deploy.
 *
 * Usage:
 *   tsx scripts/deploy-health-gate.ts --url https://staging.wallet.example/health
 *   tsx scripts/deploy-health-gate.ts --url http://localhost:4001/health --consecutive 5 --timeout-ms 60000
 *
 * Exit codes:
 *   0  — healthy for `--consecutive` consecutive checks within the timeout
 *   1  — timed out before reaching `--consecutive` consecutive healthy checks
 *   2  — invalid arguments
 */

export interface HealthGateOptions {
  url: string;
  /** How many consecutive healthy responses are required before declaring success. Default 3. */
  consecutive?: number;
  /** Give up after this many ms. Default 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Delay between polls, in ms. Default 2_000. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the real fetch + a real sleep. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Called after every poll attempt, for progress logging. */
  onAttempt?: (result: HealthGateAttempt) => void;
}

export interface HealthGateAttempt {
  attempt: number;
  healthy: boolean;
  statusCode?: number;
  error?: string;
  consecutiveHealthy: number;
}

export interface HealthGateResult {
  ok: boolean;
  attempts: HealthGateAttempt[];
  /** Only set when ok is false: "timeout". */
  reason?: "timeout";
}

const DEFAULT_CONSECUTIVE = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Poll `options.url` until it reports healthy `options.consecutive` times in
 * a row, or `options.timeoutMs` elapses. A single flaky/unhealthy response
 * resets the consecutive-success counter to zero rather than aborting
 * immediately — the gate is meant to confirm STABLE health, not just one
 * lucky response, so it doesn't wave through a service that is still
 * intermittently failing right after startup.
 */
export async function runHealthGate(options: HealthGateOptions): Promise<HealthGateResult> {
  const consecutiveRequired = options.consecutive ?? DEFAULT_CONSECUTIVE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  const attempts: HealthGateAttempt[] = [];
  let consecutiveHealthy = 0;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    let healthy = false;
    let statusCode: number | undefined;
    let error: string | undefined;

    try {
      const response = await fetchImpl(options.url);
      statusCode = response.status;
      healthy = response.ok;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    consecutiveHealthy = healthy ? consecutiveHealthy + 1 : 0;
    const attempt: HealthGateAttempt = {
      attempt: attempts.length + 1,
      healthy,
      statusCode,
      error,
      consecutiveHealthy,
    };
    attempts.push(attempt);
    options.onAttempt?.(attempt);

    if (consecutiveHealthy >= consecutiveRequired) {
      return { ok: true, attempts };
    }

    if (now() + intervalMs >= deadline) break;
    await sleepImpl(intervalMs);
  }

  return { ok: false, attempts, reason: "timeout" };
}

function parseArgs(argv: string[]): HealthGateOptions | { error: string } {
  let url: string | undefined;
  let consecutive: number | undefined;
  let timeoutMs: number | undefined;
  let intervalMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--url":
        url = next();
        break;
      case "--consecutive":
        consecutive = Number(next());
        break;
      case "--timeout-ms":
        timeoutMs = Number(next());
        break;
      case "--interval-ms":
        intervalMs = Number(next());
        break;
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }

  if (!url) return { error: "--url is required" };
  if (consecutive !== undefined && (!Number.isInteger(consecutive) || consecutive < 1)) {
    return { error: "--consecutive must be a positive integer" };
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    return { error: "--timeout-ms must be a positive integer" };
  }
  if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 1)) {
    return { error: "--interval-ms must be a positive integer" };
  }

  return { url, consecutive, timeoutMs, intervalMs };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    console.error(
      "Usage: tsx scripts/deploy-health-gate.ts --url <health-url> [--consecutive N] [--timeout-ms N] [--interval-ms N]",
    );
    process.exit(2);
  }

  console.log(
    `Polling ${parsed.url} — need ${parsed.consecutive ?? DEFAULT_CONSECUTIVE} consecutive healthy responses within ${parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms...`,
  );

  const result = await runHealthGate({
    ...parsed,
    onAttempt: (attempt) => {
      const status = attempt.healthy ? "healthy" : "unhealthy";
      console.log(
        `  attempt ${attempt.attempt}: ${status}${attempt.statusCode ? ` (HTTP ${attempt.statusCode})` : ""}${attempt.error ? ` — ${attempt.error}` : ""} (${attempt.consecutiveHealthy} consecutive)`,
      );
    },
  });

  if (result.ok) {
    console.log(`✓ Healthy for ${parsed.consecutive ?? DEFAULT_CONSECUTIVE} consecutive checks. Safe to proceed.`);
    process.exit(0);
  } else {
    console.error(
      `✗ Timed out after ${result.attempts.length} attempts without reaching the required consecutive-healthy streak. Do NOT proceed with the cutover/promotion.`,
    );
    process.exit(1);
  }
}

// Only run when invoked directly (tsx scripts/deploy-health-gate.ts), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
