# Issue 343 — Data Retention Policy Job for Expired Sessions

Sandboxed reference implementation (per `contrib/README.md`, this cannot touch
`services/wallet-service` directly — see the PR description for why) of a
scheduled job that physically deletes `wallet_sessions` rows once they are
past a configurable retention window, past their `expires_at`.

## Why this job is needed

`services/wallet-service`'s real `SessionRepository` (`src/repository.ts`,
`src/db/pg-repository.ts`) already treats an expired session as **logically
absent** — `find`/`listByContract` filter on `expiresAt` so an expired id
never authorizes anything. But nothing ever **physically deletes** an expired
row; `walletSessions` only shrinks via the single-row `delete(id)` a user
triggers through `POST /wallet/sessions/revoke`. Expired rows accumulate
forever, which is a real (if low-severity) storage-growth and
data-minimization gap: session rows carry `contractId` + timestamps
indefinitely after they've stopped being useful for anything.

This module is the retention sweep that closes that gap: a scheduled job,
matching this repo's existing scheduled-job convention, that deletes
`wallet_sessions` rows whose `expires_at` is older than
`now - retentionWindowMs`.

## Design, matching existing repo conventions

- **Scheduling pattern**: this repo has no cron library (no BullMQ, no
  `node-cron`, no Redis anywhere — confirmed by grep). The one precedent,
  `services/worker-service/src/index.ts`, wires scheduled work as a plain
  `setInterval` in the service entrypoint, runs once immediately, and clears
  the timer on `SIGINT`/`SIGTERM`:
  ```ts
  const reapTimer = setInterval(runReaper, config.reapIntervalMs);
  void runReaper();
  // ...
  const shutdown = async () => { ...; clearInterval(reapTimer); ... };
  ```
  `route.mjs` in this folder follows the exact same shape:
  `startRetentionJob()` returns `{ stop() }`, runs once immediately, then on
  `intervalMs`, and is safe to `clearInterval` from a shutdown handler.

- **Deletion query**: matches the real `createPgSessionRepository` pattern in
  `services/wallet-service/src/db/pg-repository.ts`, which already imports
  `and, desc, eq, gt` from `drizzle-orm` and does
  `db.delete(walletSessions).where(eq(walletSessions.id, id))` for a
  single-row delete. A real integration would add one bulk method to
  `SessionRepository`:
  ```ts
  // services/wallet-service/src/repository.ts
  export interface SessionRepository {
    // ...
    /** Physically deletes sessions whose expiresAt < cutoff. Returns count deleted. */
    deleteExpiredBefore(cutoff: Date): Promise<number>;
  }

  // services/wallet-service/src/db/pg-repository.ts
  async deleteExpiredBefore(cutoff) {
    const deleted = await db
      .delete(walletSessions)
      .where(lt(walletSessions.expiresAt, cutoff))
      .returning({ id: walletSessions.id });
    return deleted.length;
  }
  ```
  This module's `mockSessionStore` implements that same
  `deleteExpiredBefore(cutoff)` contract in-memory (no real DB dependency in
  `contrib/`), so the sweep logic under test is the real logic, not a fake.

- **Configurable retention window**: `RETENTION_WINDOW_MS` env var (default
  30 days), read the same way `worker-service/src/config.ts` reads its
  interval env vars — `Number(env.VAR) || default`. The window is deliberately
  **independent of and longer than** the session's own 7-day sliding
  `expiresAt` TTL (`services/wallet-service/src/server.ts:65`,
  `SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000`): the row goes logically-dead at
  `expiresAt`, then stays physically queryable for `RETENTION_WINDOW_MS`
  longer before the sweep purges it — a deliberate grace period in case an
  expired-but-recent session is ever needed for incident investigation or
  audit correlation (the `activityLogs`/audit-log table already reflects the
  session's past activity independently, so deleting the session row itself
  doesn't lose audit history).

- **Cutoff, not "no rows younger than expiry"**: the job never deletes a row
  whose `expiresAt` is in the future or within the grace window — only rows
  where `expiresAt < now - retentionWindowMs`. This is what the test suite
  below is built to prove.

## Files

- `route.mjs` — `computeExpiredCutoff`, `mockSessionStore` (the
  `deleteExpiredBefore` contract above, in-memory), and `startRetentionJob`
  (the `setInterval`-based scheduler, matching worker-service's shape).
- `route.test.mjs` — asserts the sweep deletes ONLY sessions whose
  `expiresAt` is older than the retention cutoff, and leaves active
  (non-expired) and grace-period sessions untouched.

## Running standalone

```sh
node contrib/routes/issue-343-session-retention-job/route.mjs
```

Starts an HTTP mock (`PORT`, default `4343`) exposing `POST /sweep` to trigger
one sweep pass on demand and `GET /sessions` to inspect the in-memory store —
useful for manually exercising the job shape without a real database.

## Tests

```sh
node contrib/routes/issue-343-session-retention-job/route.test.mjs
```
