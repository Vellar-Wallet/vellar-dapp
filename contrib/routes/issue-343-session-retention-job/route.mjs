import http from "node:http";

// Sandboxed reference implementation of issue #343 (data retention job for
// expired wallet_sessions rows). See README.md for how this maps onto the
// real services/wallet-service schema and scheduling convention.

/** Default retention window: 30 days past a session's expiresAt before its
 * row is physically deleted. Deliberately independent of, and longer than,
 * the session's own 7-day sliding TTL (services/wallet-service/src/server.ts
 * SESSION_TTL_MS) — expired rows get a grace period before the sweep purges
 * them. */
export const DEFAULT_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Same "env var with numeric default" pattern used throughout the repo's
 * service configs (e.g. services/worker-service/src/config.ts). */
export function retentionWindowMsFromEnv(env = process.env) {
  const raw = Number(env.RETENTION_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_WINDOW_MS;
}

/** A row is eligible for physical deletion once `expiresAt < cutoff`, where
 * cutoff = now - retentionWindowMs. Exported standalone so it's trivially
 * unit-testable without touching the store. */
export function computeExpiredCutoff(now, retentionWindowMs) {
  return new Date(now.getTime() - retentionWindowMs);
}

/**
 * In-memory stand-in for services/wallet-service's real SessionRepository,
 * extended with the one bulk method that repository doesn't have yet:
 * deleteExpiredBefore(cutoff). Mirrors the real row shape
 * (services/wallet-service/src/db/schema.ts walletSessions) and the real
 * delete-by-predicate style already used in
 * services/wallet-service/src/db/pg-repository.ts
 * (`db.delete(walletSessions).where(...)`).
 */
export function mockSessionStore(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.id, r]));
  return {
    insert(row) {
      rows.set(row.id, row);
    },
    get(id) {
      return rows.get(id);
    },
    all() {
      return [...rows.values()];
    },
    /** Physically deletes every row whose expiresAt < cutoff. Returns the
     * deleted rows (mirrors drizzle's `.returning()` used elsewhere in this
     * repo's pg-repository.ts, so a real port keeps the same call shape). */
    async deleteExpiredBefore(cutoff) {
      const deleted = [];
      for (const row of rows.values()) {
        if (row.expiresAt.getTime() < cutoff.getTime()) {
          rows.delete(row.id);
          deleted.push(row);
        }
      }
      return deleted;
    },
  };
}

/**
 * One sweep pass: compute the cutoff and delete everything past it. Returns
 * a summary object so callers (the scheduler below, or a manual trigger) can
 * log/report what happened — matching worker-service's reaper, which logs
 * `reclaimed`/`deadLettered` counts after each pass.
 */
export async function runRetentionSweep(store, { now = new Date(), retentionWindowMs } = {}) {
  const windowMs = retentionWindowMs ?? DEFAULT_RETENTION_WINDOW_MS;
  const cutoff = computeExpiredCutoff(now, windowMs);
  const deleted = await store.deleteExpiredBefore(cutoff);
  return { cutoff, deletedCount: deleted.length, deletedIds: deleted.map((r) => r.id) };
}

/**
 * Scheduled job wiring, matching services/worker-service/src/index.ts's
 * setInterval convention exactly: run once immediately, then every
 * intervalMs, and expose stop() so a SIGINT/SIGTERM handler can clearInterval
 * cleanly (see e.g. worker-service's `shutdown()`).
 */
export function startRetentionJob(store, { intervalMs, retentionWindowMs, log, onSweep } = {}) {
  const effectiveIntervalMs = intervalMs ?? 24 * 60 * 60 * 1000; // once/day default
  const logger = log ?? {
    info: (msg) => console.log(`[session-retention-job] ${msg}`),
    error: (msg, err) => console.error(`[session-retention-job] ${msg}`, err ?? ""),
  };

  const runOnce = async () => {
    try {
      const result = await runRetentionSweep(store, { retentionWindowMs });
      if (result.deletedCount > 0) {
        logger.info(`swept ${result.deletedCount} expired session(s) past retention window`);
      }
      onSweep?.(result);
      return result;
    } catch (err) {
      logger.error("retention sweep failed", err);
      return undefined;
    }
  };

  const timer = setInterval(runOnce, effectiveIntervalMs);
  void runOnce();

  return {
    stop() {
      clearInterval(timer);
    },
    runOnce,
  };
}

// --- Optional standalone HTTP mock, matching the repo's contrib/ pattern
// (see contrib/routes/issue-305-gateway-alerting/route.mjs) ---

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const store = mockSessionStore([
    {
      id: "seed-active",
      contractId: "CACTIVE",
      network: "testnet",
      createdAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    {
      id: "seed-expired-recent",
      contractId: "CRECENT",
      network: "testnet",
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      lastActiveAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // expired, still in grace window
    },
    {
      id: "seed-expired-old",
      contractId: "COLD",
      network: "testnet",
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      lastActiveAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // past retention window, sweep target
    },
  ]);

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/sweep") {
      runRetentionSweep(store).then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.all()));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const port = process.env.PORT || 4343;
  server.listen(port, () => console.log(`issue-343 mock listening on port ${port}`));
}
