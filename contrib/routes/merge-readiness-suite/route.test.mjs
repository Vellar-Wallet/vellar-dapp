import assert from "node:assert/strict";
import {
  inspect,
  resolveBlocker,
  getReadiness,
  confirmReadiness,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

// Stage 1 — inspection. Blockers come back worst severity first, all unresolved.
let inspected = inspect("GA_BLOCKED");
assert.equal(inspected.status, 200);
assert.equal(inspected.payload.account.account, "GA_BLOCKED");
assert.equal(inspected.payload.blockerCount, 4);
assert.equal(inspected.payload.outstandingCount, 4);
assert.deepEqual(
  inspected.payload.blockers.map((blocker) => blocker.severity),
  ["high", "high", "medium", "low"],
);
assert.ok(inspected.payload.blockers.every((blocker) => blocker.resolved === false));
assert.ok(inspected.payload.blockers.every((blocker) => typeof blocker.message === "string"));

// Inspect: unknown account.
assert.equal(inspect("GA_NOBODY").status, 404);
assert.equal(inspect("GA_NOBODY").payload.error, "account_not_found");
assert.equal(inspect(undefined).status, 404);

// Readiness before any work: not ready, every blocker outstanding.
let readiness = getReadiness("GA_BLOCKED");
assert.equal(readiness.status, 200);
assert.equal(readiness.payload.ready, false);
assert.equal(readiness.payload.outstanding.length, 4);
assert.deepEqual(readiness.payload.resolved, []);
assert.equal(readiness.payload.confirmed, false);
assert.equal(readiness.payload.confirmationId, null);

// Confirming while blockers remain is refused, and names what is outstanding.
let refused = confirmReadiness({ account: "GA_BLOCKED" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "not_ready");
assert.equal(refused.payload.ready, false);
assert.equal(refused.payload.outstanding.length, 4);

// Stage 2 — blocker resolution, in any order. Severity does not gate it.
let resolved = resolveBlocker({ account: "GA_BLOCKED", blocker: "account-flags" });
assert.equal(resolved.status, 200);
assert.equal(resolved.payload.blocker, "account-flags");
assert.equal(resolved.payload.severity, "low");
assert.equal(resolved.payload.alreadyResolved, false);
assert.equal(resolved.payload.ready, false);
assert.equal(resolved.payload.outstanding.length, 3);
// `blocker` names what was just resolved; `resolved` stays the full cleared list.
assert.deepEqual(resolved.payload.resolved, ["account-flags"]);

// The resolution shows up on a re-inspection.
inspected = inspect("GA_BLOCKED");
assert.equal(inspected.payload.outstandingCount, 3);
const flags = inspected.payload.blockers.find((blocker) => blocker.id === "account-flags");
assert.equal(flags.resolved, true);

// Resolution is idempotent — re-resolving reports it rather than failing.
resolved = resolveBlocker({ account: "GA_BLOCKED", blocker: "account-flags" });
assert.equal(resolved.status, 200);
assert.equal(resolved.payload.alreadyResolved, true);
assert.equal(getReadiness("GA_BLOCKED").payload.outstanding.length, 3);

// A blocker that is not on this account is a 404.
refused = resolveBlocker({ account: "GA_BLOCKED", blocker: "not-a-blocker" });
assert.equal(refused.status, 404);
assert.equal(refused.payload.error, "blocker_not_found");
assert.ok(refused.payload.accountBlockers.includes("extra-signers"));

// A blocker that exists on a DIFFERENT sample account is still a 404 here.
refused = resolveBlocker({ account: "GA_READY", blocker: "extra-signers" });
assert.equal(refused.status, 404);
assert.equal(refused.payload.error, "blocker_not_found");

// Resolve: unknown account.
assert.equal(resolveBlocker({ account: "GA_NOBODY", blocker: "open-offers" }).status, 404);
assert.equal(resolveBlocker({}).status, 404);

// With one blocker still outstanding, confirmation is still refused.
for (const blocker of ["open-offers", "extra-signers"]) {
  assert.equal(resolveBlocker({ account: "GA_BLOCKED", blocker }).status, 200);
}
readiness = getReadiness("GA_BLOCKED");
assert.equal(readiness.payload.ready, false);
assert.deepEqual(readiness.payload.outstanding, ["open-trustlines"]);
assert.equal(confirmReadiness({ account: "GA_BLOCKED" }).status, 409);

// Stage 3 — the last blocker clears, and readiness flips.
resolved = resolveBlocker({ account: "GA_BLOCKED", blocker: "open-trustlines" });
assert.equal(resolved.payload.ready, true);
assert.deepEqual(resolved.payload.outstanding, []);

readiness = getReadiness("GA_BLOCKED");
assert.equal(readiness.payload.ready, true);
assert.equal(readiness.payload.resolved.length, 4);
assert.equal(readiness.payload.confirmed, false, "readiness alone is not a confirmation");

// The confirmation is issued, and pins the blocker set it was issued against.
const confirmed = confirmReadiness({ account: "GA_BLOCKED" });
assert.equal(confirmed.status, 201);
assert.equal(confirmed.payload.ready, true);
assert.equal(confirmed.payload.alreadyConfirmed, false);
assert.ok(confirmed.payload.confirmationId);
assert.ok(confirmed.payload.confirmedAt);
assert.equal(confirmed.payload.totalBlockers, 4);
assert.equal(confirmed.payload.resolvedBlockers.length, 4);
assert.ok(confirmed.payload.resolvedBlockers.includes("open-trustlines"));

// Readiness now reports the confirmation.
readiness = getReadiness("GA_BLOCKED");
assert.equal(readiness.payload.confirmed, true);
assert.equal(readiness.payload.confirmationId, confirmed.payload.confirmationId);

// Re-confirming returns the original record rather than minting a second one.
const reconfirmed = confirmReadiness({ account: "GA_BLOCKED" });
assert.equal(reconfirmed.status, 200);
assert.equal(reconfirmed.payload.alreadyConfirmed, true);
assert.equal(reconfirmed.payload.confirmationId, confirmed.payload.confirmationId);
assert.equal(reconfirmed.payload.confirmedAt, confirmed.payload.confirmedAt);

// An account whose inspection finds no blockers is ready immediately and can be
// confirmed without a resolution step.
assert.equal(inspect("GA_READY").payload.blockerCount, 0);
assert.equal(getReadiness("GA_READY").payload.ready, true);
const readyConfirmed = confirmReadiness({ account: "GA_READY" });
assert.equal(readyConfirmed.status, 201);
assert.equal(readyConfirmed.payload.totalBlockers, 0);
assert.deepEqual(readyConfirmed.payload.resolvedBlockers, []);

// Accounts are tracked independently — confirming one must not affect another.
assert.equal(getReadiness("GA_ONE_BLOCKER").payload.ready, false);
assert.equal(getReadiness("GA_ONE_BLOCKER").payload.confirmed, false);
assert.equal(confirmReadiness({ account: "GA_ONE_BLOCKER" }).status, 409);
resolveBlocker({ account: "GA_ONE_BLOCKER", blocker: "open-trustlines" });
const oneBlockerConfirmed = confirmReadiness({ account: "GA_ONE_BLOCKER" });
assert.equal(oneBlockerConfirmed.status, 201);
assert.notEqual(oneBlockerConfirmed.payload.confirmationId, confirmed.payload.confirmationId);

// Confirm: unknown account.
assert.equal(confirmReadiness({ account: "GA_NOBODY" }).status, 404);
assert.equal(confirmReadiness({}).status, 404);

// A mutated inspect response must not corrupt the blocker table.
resetState();
const snapshot = inspect("GA_BLOCKED");
snapshot.payload.blockers[0].message = "tampered";
assert.notEqual(inspect("GA_BLOCKED").payload.blockers[0].message, "tampered");

// resetState clears resolutions and confirmations alike.
resolveBlocker({ account: "GA_BLOCKED", blocker: "open-offers" });
resetState();
assert.equal(getReadiness("GA_BLOCKED").payload.resolved.length, 0);
assert.equal(getReadiness("GA_BLOCKED").payload.confirmed, false);

// Routing.
assert.equal(
  handleRequest("GET", "/inspect", undefined, { account: "GA_ONE_BLOCKER" }).status,
  200,
);
assert.equal(
  handleRequest("POST", "/confirm", { account: "GA_ONE_BLOCKER" }).payload.error,
  "not_ready",
);
assert.equal(
  handleRequest("POST", "/resolve", { account: "GA_ONE_BLOCKER", blocker: "open-trustlines" })
    .payload.ready,
  true,
);
assert.equal(
  handleRequest("GET", "/readiness", undefined, { account: "GA_ONE_BLOCKER" }).payload.ready,
  true,
);
assert.equal(handleRequest("POST", "/confirm", { account: "GA_ONE_BLOCKER" }).status, 201);
assert.equal(handleRequest("GET", "/confirm", undefined, {}).status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

console.log(
  "PASS: /inspect ranks merge blockers, /resolve clears them idempotently, and /confirm issues a readiness record only once none remain",
);
