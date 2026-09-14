import type { NonceRepository } from "./repository";

// Background cleanup for expired registration nonces (§5.2). Rows are already
// unusable once expired — `consume` checks expiry — so this is housekeeping to
// stop the table growing without bound, never a correctness guarantee.

export interface NonceSweeperOptions {
  nonces: NonceRepository;
  intervalMs: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
}

/**
 * Sweeps on start and then every `intervalMs`. Returns a stop function.
 *
 * Failures are logged and swallowed: a sweep that throws (Postgres briefly
 * down) must not take the service with it, and the next tick retries. The
 * timer is unref'd so it never holds the process open on shutdown.
 */
export function startNonceSweeper(options: NonceSweeperOptions): () => void {
  const now = options.now ?? (() => new Date());
  let stopped = false;

  const sweep = async () => {
    if (stopped) return;
    try {
      const deleted = await options.nonces.deleteExpired(now());
      if (deleted > 0) options.log?.info({ deleted }, "swept expired marketplace nonces");
    } catch (err) {
      options.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "marketplace nonce sweep failed; will retry on the next interval",
      );
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), options.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
