import { describe, expect, it } from "vitest";
import { createMemoryJobStore } from "./memory-job-store";
import type { VerificationJobInput } from "./verify";

const job = (contractId: string): VerificationJobInput => ({
  contractId,
  sourceType: "repo",
  repoUrl: "https://github.com/x/y",
  commitHash: "abc1234",
  toolchainVersion: "1.94.0",
});

describe("memory job store — reaper (M7)", () => {
  it("reclaims a row stuck in 'building' past the timeout, back to 'submitted'", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job("C1"), 0);
    await store.claimSubmitted(1); // -> building, stamps startedBuildingAtMs
    const started = store.get("r1")!.startedBuildingAtMs!;
    // Not yet timed out.
    let res = await store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: started + 899_999,
    });
    expect(res.reclaimed).toBe(0);
    expect(store.get("r1")!.status).toBe("building");
    // Past the timeout -> reclaimed to submitted.
    res = await store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: started + 900_001,
    });
    expect(res.reclaimed).toBe(1);
    expect(store.get("r1")!.status).toBe("submitted");
  });

  it("parks a job in 'dead_letter' after maxAttempts instead of looping forever", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job("C1"), 0);
    // maxAttempts = 3: strand it 3 times; the 3rd strand dead-letters it.
    for (let i = 1; i <= 3; i++) {
      await store.claimSubmitted(1);
      const started = store.get("r1")!.startedBuildingAtMs!;
      const res = await store.reapStranded({
        timeoutMs: 900_000,
        maxAttempts: 3,
        nowMs: started + 900_001,
      });
      if (i < 3) {
        expect(res.reclaimed).toBe(1);
        expect(res.deadLettered).toBe(0);
        expect(store.get("r1")!.status).toBe("submitted");
      } else {
        expect(res.reclaimed).toBe(0);
        expect(res.deadLettered).toBe(1);
        expect(store.get("r1")!.status).toBe("dead_letter");
      }
    }
    // A dead-lettered row is never claimed again.
    expect(await store.claimSubmitted(10)).toHaveLength(0);
  });

  it("does not reap a 'building' row that is still within the timeout", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job("C1"), 0);
    await store.claimSubmitted(1);
    const started = store.get("r1")!.startedBuildingAtMs!;
    const res = await store.reapStranded({
      timeoutMs: 900_000,
      maxAttempts: 3,
      nowMs: started + 899_999,
    });
    expect(res.reclaimed).toBe(0);
    expect(store.get("r1")!.status).toBe("building");
  });

  it("encounters a row manually edited to look fresh vs genuinely fresh (issue #694 accepted gap)", async () => {
    // Issue #694: Test that age-based reaper not catching an artificially updated timestamp is an accepted gap.
    // Staleness relies purely on the recorded timestamp (startedBuildingAtMs / updated_at).
    const store = createMemoryJobStore();
    const timeoutMs = 900_000; // 15 minutes
    const now = 1_000_000_000;

    // 1. Genuinely fresh row: claimed at `now`
    store.submit("fresh-row", job("C1"), now);
    // 2. Stranded row that had its timestamp manually edited to look fresh
    store.submit("tampered-row", job("C2"), now - 10_000_000);

    await store.claimSubmitted(2); // both become 'building'

    // Simulate an operator or migration script manually updating startedBuildingAtMs
    // on 'tampered-row' to make it look freshly claimed (5 seconds ago) even though
    // the worker that originally claimed it has crashed / was abandoned.
    const freshRow = store.get("fresh-row")!;
    const tamperedRow = store.get("tampered-row")!;
    freshRow.startedBuildingAtMs = now;
    tamperedRow.startedBuildingAtMs = now - 5_000; // artificially edited to look fresh

    // Run reaper at `now + 10_000` (10 seconds after `now`):
    // - fresh-row is 10s old (< 15 min timeout) -> legitimately NOT reaped
    // - tampered-row is 15s old (< 15 min timeout from edited timestamp) -> NOT reaped!
    // This demonstrates the accepted gap: the age-based reaper cannot distinguish between
    // a genuinely fresh row and an artificially edited timestamp without out-of-band heartbeats.
    let res = await store.reapStranded({
      timeoutMs,
      maxAttempts: 3,
      nowMs: now + 10_000,
    });
    expect(res.reclaimed).toBe(0);
    expect(store.get("fresh-row")!.status).toBe("building");
    expect(store.get("tampered-row")!.status).toBe("building");

    // Once the timeout actually elapses past the artificially edited timestamp
    // (now - 5_000 + 900_001 = now + 895_001):
    res = await store.reapStranded({
      timeoutMs,
      maxAttempts: 3,
      nowMs: now + 895_001,
    });
    // tampered-row has now exceeded the timeout relative to its edited timestamp and is reaped
    expect(res.reclaimed).toBe(1);
    expect(store.get("tampered-row")!.status).toBe("submitted");
    // fresh-row was started at `now`, so at `now + 895_001` (895s < 900s) it remains untouched
    expect(store.get("fresh-row")!.status).toBe("building");
  });
});

describe("memory job store — queue controls (M7)", () => {
  it("countActive counts submitted + building, not terminal states", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job("C1"));
    store.submit("r2", job("C2"));
    expect(await store.countActive()).toBe(2);
    await store.claimSubmitted(1); // one -> building, still active
    expect(await store.countActive()).toBe(2);
    await store.complete("r1", { status: "verified", statusDetail: "ok", log: "" });
    await store.complete("r2", { status: "failed", statusDetail: "no", log: "" });
    expect(await store.countActive()).toBe(0);
  });

  it("hasActiveForContract is true while submitted/building, false once terminal", async () => {
    const store = createMemoryJobStore();
    store.submit("r1", job("C1"));
    expect(await store.hasActiveForContract("C1")).toBe(true);
    expect(await store.hasActiveForContract("C2")).toBe(false);
    await store.complete("r1", { status: "verified", statusDetail: "ok", log: "" });
    // A terminal record does NOT block a fresh resubmission of the same contract.
    expect(await store.hasActiveForContract("C1")).toBe(false);
  });
});
