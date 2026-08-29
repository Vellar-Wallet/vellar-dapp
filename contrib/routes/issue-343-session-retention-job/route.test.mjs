import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_WINDOW_MS,
  computeExpiredCutoff,
  mockSessionStore,
  retentionWindowMsFromEnv,
  runRetentionSweep,
  startRetentionJob,
} from "./route.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-29T00:00:00.000Z");

function session(id, { createdDaysAgo, expiresDaysFromNow, network = "testnet" }) {
  return {
    id,
    contractId: `C${id.toUpperCase()}`,
    network,
    createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY_MS),
    lastActiveAt: new Date(NOW.getTime() - createdDaysAgo * DAY_MS),
    expiresAt: new Date(NOW.getTime() + expiresDaysFromNow * DAY_MS),
  };
}

// --- computeExpiredCutoff -----------------------------------------------

{
  const cutoff = computeExpiredCutoff(NOW, 30 * DAY_MS);
  assert.equal(cutoff.toISOString(), "2026-07-30T00:00:00.000Z");
}

// --- retentionWindowMsFromEnv --------------------------------------------

{
  assert.equal(retentionWindowMsFromEnv({}), DEFAULT_RETENTION_WINDOW_MS);
  assert.equal(retentionWindowMsFromEnv({ RETENTION_WINDOW_MS: "1000" }), 1000);
  // Invalid/garbage/negative values fall back to the default rather than
  // silently deleting everything (0) or nothing (NaN comparisons).
  assert.equal(retentionWindowMsFromEnv({ RETENTION_WINDOW_MS: "not-a-number" }), DEFAULT_RETENTION_WINDOW_MS);
  assert.equal(retentionWindowMsFromEnv({ RETENTION_WINDOW_MS: "-5" }), DEFAULT_RETENTION_WINDOW_MS);
  assert.equal(retentionWindowMsFromEnv({ RETENTION_WINDOW_MS: "0" }), DEFAULT_RETENTION_WINDOW_MS);
}

// --- runRetentionSweep: the core "only expired past the window" guarantee -

{
  const retentionWindowMs = 30 * DAY_MS;

  const active = session("active", { createdDaysAgo: 1, expiresDaysFromNow: 6 }); // not expired at all
  const expiredButInGrace = session("in-grace", { createdDaysAgo: 20, expiresDaysFromNow: -10 }); // expired 10d ago, window is 30d
  const expiredExactlyAtCutoff = session("at-cutoff", { createdDaysAgo: 40, expiresDaysFromNow: -30 }); // expiresAt == cutoff exactly
  const expiredPastWindow = session("past-window", { createdDaysAgo: 60, expiresDaysFromNow: -45 }); // expired 45d ago > 30d window
  const expiredWayPastWindow = session("way-past", { createdDaysAgo: 200, expiresDaysFromNow: -180 });

  const store = mockSessionStore([
    active,
    expiredButInGrace,
    expiredExactlyAtCutoff,
    expiredPastWindow,
    expiredWayPastWindow,
  ]);

  const result = await runRetentionSweep(store, { now: NOW, retentionWindowMs });

  // Only rows strictly older than the cutoff are deleted.
  assert.deepEqual(new Set(result.deletedIds), new Set(["past-window", "way-past"]));
  assert.equal(result.deletedCount, 2);

  // Active and in-grace sessions survive untouched.
  const remainingIds = new Set(store.all().map((r) => r.id));
  assert.ok(remainingIds.has("active"), "active session must not be deleted");
  assert.ok(remainingIds.has("in-grace"), "expired-but-within-grace session must not be deleted");
  // A row whose expiresAt is EXACTLY the cutoff is not < cutoff, so it survives
  // this pass (it becomes eligible on the next sweep once time moves forward).
  assert.ok(remainingIds.has("at-cutoff"), "row at the exact cutoff boundary must not be deleted yet");

  // Deleted rows are gone from the store entirely, not just marked.
  assert.equal(store.get("past-window"), undefined);
  assert.equal(store.get("way-past"), undefined);
}

// --- runRetentionSweep: no expired rows -> no-op, doesn't throw ----------

{
  const store = mockSessionStore([session("only-active", { createdDaysAgo: 1, expiresDaysFromNow: 5 })]);
  const result = await runRetentionSweep(store, { now: NOW, retentionWindowMs: 30 * DAY_MS });
  assert.equal(result.deletedCount, 0);
  assert.deepEqual(result.deletedIds, []);
  assert.equal(store.all().length, 1);
}

// --- runRetentionSweep: empty store -> no-op -------------------------------

{
  const store = mockSessionStore([]);
  const result = await runRetentionSweep(store, { now: NOW, retentionWindowMs: 30 * DAY_MS });
  assert.equal(result.deletedCount, 0);
}

// --- runRetentionSweep: default retention window is honored when omitted -

{
  const justOverDefault = session("default-window-target", {
    createdDaysAgo: 40,
    expiresDaysFromNow: -31, // expired 31 days ago; default window is 30 days
  });
  const justUnderDefault = session("default-window-survivor", {
    createdDaysAgo: 40,
    expiresDaysFromNow: -29, // expired 29 days ago; still within default 30-day window
  });
  const store = mockSessionStore([justOverDefault, justUnderDefault]);
  const result = await runRetentionSweep(store, { now: NOW }); // no retentionWindowMs passed
  assert.deepEqual(result.deletedIds, ["default-window-target"]);
}

// --- startRetentionJob: runs once immediately, then on the interval ------

{
  let sweepCount = 0;
  const store = mockSessionStore([
    session("immediate-target", { createdDaysAgo: 60, expiresDaysFromNow: -45 }),
  ]);
  const silentLog = { info: () => {}, error: () => {} };

  const job = startRetentionJob(store, {
    intervalMs: 60_000,
    retentionWindowMs: 30 * DAY_MS,
    log: silentLog,
    onSweep: () => {
      sweepCount += 1;
    },
  });

  // The immediate run is fired via `void runOnce()` (fire-and-forget), so
  // give the microtask queue a tick to let it settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sweepCount, 1, "job must sweep once immediately on start, matching worker-service's convention");
  assert.equal(store.all().length, 0, "the immediate sweep must have deleted the past-window session");

  job.stop();
}

// --- startRetentionJob: stop() actually clears the interval ---------------

{
  let sweepCount = 0;
  const store = mockSessionStore([]);
  const silentLog = { info: () => {}, error: () => {} };

  const job = startRetentionJob(store, {
    intervalMs: 5, // fast interval so we can observe ticks in a short test
    log: silentLog,
    onSweep: () => {
      sweepCount += 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  job.stop();
  const countAtStop = sweepCount;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.ok(countAtStop >= 1, "job should have swept at least once before stop()");
  assert.equal(sweepCount, countAtStop, "no further sweeps must fire after stop()");
}

// --- runRetentionSweep: a store failure surfaces to the caller rather than
// silently vanishing (relevant for startRetentionJob's try/catch around it) -

{
  const throwingStore = {
    async deleteExpiredBefore() {
      throw new Error("connection reset");
    },
  };
  await assert.rejects(
    () => runRetentionSweep(throwingStore, { now: NOW, retentionWindowMs: 30 * DAY_MS }),
    /connection reset/,
  );
}

// --- startRetentionJob: a sweep failure is caught and logged, job keeps running -

{
  let errorLogged = false;
  const throwingStore = {
    async deleteExpiredBefore() {
      throw new Error("boom");
    },
  };
  const job = startRetentionJob(throwingStore, {
    intervalMs: 60_000,
    log: {
      info: () => {},
      error: () => {
        errorLogged = true;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(errorLogged, "a failed sweep must be logged, not thrown into the event loop");
  job.stop();
}

console.log("PASS: Issue 343 session retention job tests passed cleanly!");
