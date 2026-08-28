import assert from "node:assert/strict";
import {
  getPolicy,
  notify,
  getPending,
  flush,
  getDigests,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

const T0 = 1_000_000;
const WINDOW = 300_000;

// The batching rules are readable without sending anything.
const policy = getPolicy();
assert.equal(policy.status, 200);
assert.equal(policy.payload.windowMs, WINDOW);
assert.equal(policy.payload.maxBatch, 5);

// ---------------------------------------------------------------------------
// The window opens with the FIRST notification and does not move. A debounce
// would restart it on every arrival and, under a steady stream, never fire.
// ---------------------------------------------------------------------------
let res = notify({ recipient: "alice", subject: "Payment received", kind: "payment", time: T0 });
assert.equal(res.status, 201);
assert.equal(res.payload.buffered, true);
assert.equal(res.payload.digest, null);
assert.equal(res.payload.notification.kind, "payment");
assert.equal(res.payload.notification.priority, "normal");
assert.equal(res.payload.pending.count, 1);
assert.equal(res.payload.pending.windowOpenedAt, T0);
assert.equal(res.payload.pending.windowClosesAt, T0 + WINDOW);
assert.equal(res.payload.pending.msRemaining, WINDOW);
assert.equal(res.payload.pending.due, false);

// A second arrival joins the batch without pushing the deadline out.
res = notify({ recipient: "alice", subject: "Trustline added", time: T0 + 120_000 });
assert.equal(res.payload.pending.count, 2);
assert.equal(res.payload.pending.windowOpenedAt, T0, "still anchored to the first");
assert.equal(res.payload.pending.msRemaining, WINDOW - 120_000);
assert.equal(res.payload.notification.kind, "notice", "kind defaults");

// A third, arriving after the original window would have closed, does not
// reopen it -- the batch is already overdue.
res = notify({ recipient: "alice", subject: "Signer rotated", time: T0 + WINDOW + 1 });
assert.equal(res.payload.pending.count, 3);
assert.equal(res.payload.pending.windowOpenedAt, T0);
assert.equal(res.payload.pending.msRemaining, 0);
assert.equal(res.payload.pending.due, true);
assert.equal(res.payload.pending.dueReason, "window_elapsed");

// ---------------------------------------------------------------------------
// Flushing early is refused; the job cannot fragment one window into several
// undersized digests.
// ---------------------------------------------------------------------------
resetState();
notify({ recipient: "bob", subject: "First", time: T0 });
notify({ recipient: "bob", subject: "Second", time: T0 + 1000 });

let refused = flush({ recipient: "bob", time: T0 + 1000 });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "window_open");
assert.equal(refused.payload.count, 2);
assert.equal(refused.payload.msRemaining, WINDOW - 1000);
assert.equal(getDigests("bob").payload.count, 0, "the refusal emitted nothing");

// One millisecond short of the window is still open...
assert.equal(getPending("bob", T0 + WINDOW - 1).payload.due, false);
assert.equal(flush({ recipient: "bob", time: T0 + WINDOW - 1 }).payload.error, "window_open");

// ...and exactly at the window it is due.
assert.equal(getPending("bob", T0 + WINDOW).payload.due, true);
assert.equal(getPending("bob", T0 + WINDOW).payload.dueReason, "window_elapsed");

let flushed = flush({ recipient: "bob", time: T0 + WINDOW });
assert.equal(flushed.status, 200);
assert.equal(flushed.payload.digest.reason, "window_elapsed");
assert.equal(flushed.payload.digest.count, 2, "two notifications, one digest");
assert.deepEqual(
  flushed.payload.digest.notifications.map((entry) => entry.subject),
  ["First", "Second"],
);
assert.equal(flushed.payload.digest.windowOpenedAt, T0);
assert.equal(flushed.payload.digest.emittedAt, T0 + WINDOW);

// The buffer is drained and the window closed behind it.
assert.equal(flushed.payload.pending.count, 0);
assert.equal(flushed.payload.pending.windowOpenedAt, null);
assert.equal(flushed.payload.pending.msRemaining, null);
assert.equal(flushed.payload.pending.due, false);

// Flushing a drained buffer is a no-op, not a second empty digest.
refused = flush({ recipient: "bob", time: T0 + WINDOW + 1 });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "nothing_pending");
assert.equal(getDigests("bob").payload.count, 1);

// The next notification opens a fresh window from where it arrives.
res = notify({ recipient: "bob", subject: "Third", time: T0 + WINDOW + 5000 });
assert.equal(res.payload.pending.windowOpenedAt, T0 + WINDOW + 5000);
assert.equal(res.payload.pending.count, 1);

// ---------------------------------------------------------------------------
// A full buffer is due early, and outranks the window as the reported reason.
// ---------------------------------------------------------------------------
resetState();
for (let i = 1; i <= 4; i++) {
  const step = notify({ recipient: "carol", subject: `Event ${i}`, time: T0 + i });
  assert.equal(step.payload.pending.due, false, "four is not yet full");
}
res = notify({ recipient: "carol", subject: "Event 5", time: T0 + 5 });
assert.equal(res.payload.pending.count, 5);
assert.equal(res.payload.pending.due, true);
assert.equal(res.payload.pending.dueReason, "batch_full");
assert.ok(res.payload.pending.msRemaining > 0, "due despite the window still running");

flushed = flush({ recipient: "carol", time: T0 + 6 });
assert.equal(flushed.payload.digest.reason, "batch_full");
assert.equal(flushed.payload.digest.count, 5);

// Past the cap, both conditions hold; batch_full is the one reported.
for (let i = 1; i <= 6; i++) notify({ recipient: "carol", subject: `Later ${i}`, time: T0 + 10 });
assert.equal(getPending("carol", T0 + WINDOW + 100).payload.dueReason, "batch_full");
assert.equal(flush({ recipient: "carol", time: T0 + WINDOW + 100 }).payload.digest.count, 6);

// ---------------------------------------------------------------------------
// An urgent notification emits on arrival and takes the pending batch with it.
// ---------------------------------------------------------------------------
resetState();
notify({ recipient: "dave", subject: "Payment received", time: T0 });
notify({ recipient: "dave", subject: "Trustline added", time: T0 + 100 });

const urgent = notify({
  recipient: "dave",
  subject: "Signer removed from your wallet",
  kind: "security",
  priority: "urgent",
  time: T0 + 200,
});
assert.equal(urgent.status, 201);
assert.equal(urgent.payload.buffered, false, "urgent does not wait for the job");
assert.ok(urgent.payload.digest);
assert.equal(urgent.payload.digest.reason, "urgent");
assert.equal(urgent.payload.digest.count, 3, "the pending batch rode along");
assert.deepEqual(
  urgent.payload.digest.notifications.map((entry) => entry.priority),
  ["normal", "normal", "urgent"],
);
assert.equal(urgent.payload.digest.windowOpenedAt, T0, "the window it cut short");

// The buffer is empty and the window closed.
assert.equal(urgent.payload.pending.count, 0);
assert.equal(urgent.payload.pending.windowOpenedAt, null);
assert.equal(flush({ recipient: "dave", time: T0 + 300 }).payload.error, "nothing_pending");

// An urgent notification with nothing buffered is a digest of one.
const lone = notify({
  recipient: "erin",
  subject: "Suspicious login",
  priority: "urgent",
  time: T0,
});
assert.equal(lone.payload.digest.count, 1);
assert.equal(lone.payload.digest.reason, "urgent");

// ---------------------------------------------------------------------------
// The simulated clock is monotonic. A caller replaying an older timestamp must
// not be able to reopen a window that has already closed.
// ---------------------------------------------------------------------------
resetState();
notify({ recipient: "frank", subject: "First", time: T0 + 10_000 });

refused = notify({ recipient: "frank", subject: "Backdated", time: T0 });
assert.equal(refused.status, 400);
assert.equal(refused.payload.error, "time_went_backwards");
assert.equal(refused.payload.received, T0);
assert.equal(refused.payload.lastObservedTime, T0 + 10_000);
assert.equal(getPending("frank", T0 + 10_000).payload.count, 1, "nothing was buffered");

assert.equal(flush({ recipient: "frank", time: T0 }).payload.error, "time_went_backwards");
assert.equal(getPending("frank", T0).payload.error, "time_went_backwards");

// The same instant twice is fine -- notifications can share a timestamp.
assert.equal(notify({ recipient: "frank", subject: "Same ms", time: T0 + 10_000 }).status, 201);
assert.equal(getPending("frank", T0 + 10_000).payload.count, 2);

// A read does not move the clock forward, so a later read cannot strand an
// earlier write.
getPending("frank", T0 + 999_000);
assert.equal(notify({ recipient: "frank", subject: "Still ok", time: T0 + 20_000 }).status, 201);

// Nor does a REFUSED call. An invalid notification carrying a far-future time
// must not drag the clock forward on its way out and strand later valid ones.
assert.equal(notify({ recipient: "frank", time: T0 + 999_000 }).payload.field, "subject");
assert.equal(
  notify({ recipient: "frank", subject: "x", priority: "whenever", time: T0 + 999_000 }).payload
    .field,
  "priority",
);
assert.equal(notify({ recipient: "frank", subject: "Unstranded", time: T0 + 30_000 }).status, 201);

// A flush that emits nothing is not an observation of the clock either --
// neither the empty-buffer case nor the not-due-yet case.
assert.equal(flush({ recipient: "gus", time: T0 + 999_000 }).payload.error, "nothing_pending");
assert.equal(notify({ recipient: "gus", subject: "First", time: T0 }).status, 201);

assert.equal(flush({ recipient: "gus", time: T0 + 1000 }).payload.error, "window_open");
assert.equal(notify({ recipient: "gus", subject: "Second", time: T0 + 500 }).status, 201);

// A flush that DOES emit moves the clock, as a real tick should.
assert.equal(flush({ recipient: "gus", time: T0 + WINDOW }).status, 200);
assert.equal(
  notify({ recipient: "gus", subject: "Too late", time: T0 + 1000 }).payload.error,
  "time_went_backwards",
);

// ---------------------------------------------------------------------------
// Recipients are independent -- buffers, windows and clocks alike.
// ---------------------------------------------------------------------------
resetState();
notify({ recipient: "gina", subject: "G1", time: T0 });
notify({ recipient: "hank", subject: "H1", time: T0 + 50_000 });

assert.equal(getPending("gina", T0 + WINDOW).payload.due, true);
assert.equal(getPending("hank", T0 + WINDOW).payload.due, false, "its own window");

// gina's clock has run ahead; hank's has not, so a T0 call on hank is fine.
flush({ recipient: "gina", time: T0 + WINDOW });
assert.equal(notify({ recipient: "hank", subject: "H2", time: T0 + 50_000 }).status, 201);

assert.equal(getDigests("gina").payload.count, 1);
assert.equal(getDigests("hank").payload.count, 0);
assert.equal(getDigests().payload.count, 1, "no recipient means every digest");
assert.equal(getDigests().payload.recipient, null);
assert.equal(getDigests("nobody").payload.count, 0, "an unknown recipient is empty, not an error");

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------
assert.equal(notify({ subject: "x", time: T0 }).payload.field, "recipient");
assert.equal(notify({ recipient: "  ", subject: "x", time: T0 }).payload.field, "recipient");
assert.equal(notify({ recipient: "z", time: T0 }).payload.field, "subject");
assert.equal(notify({ recipient: "z", subject: "  ", time: T0 }).payload.field, "subject");
assert.equal(notify({ recipient: "z", subject: "x", kind: "", time: T0 }).payload.field, "kind");
assert.equal(
  notify({ recipient: "z", subject: "x", priority: "whenever", time: T0 }).payload.field,
  "priority",
);

// A missing or non-integer time must not be defaulted to a real clock reading:
// the whole point is that the caller owns the clock.
for (const bad of [undefined, null, "soon", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const bad_res = notify({ recipient: "z", subject: "x", time: bad });
  assert.equal(bad_res.status, 400, `expected time ${String(bad)} to be rejected`);
  assert.equal(bad_res.payload.field, "time");
}
assert.equal(notify({ recipient: "z", subject: "x" }).payload.received, null);
assert.equal(flush({ recipient: "z" }).payload.field, "time");
assert.equal(flush({}).payload.field, "recipient");
assert.equal(getPending("z").payload.field, "time");
assert.equal(getPending(undefined, T0).payload.field, "recipient");
assert.equal(getDigests("").payload.field, "recipient");

// `time` arrives as a query string over HTTP and must still be read as a number.
resetState();
notify({ recipient: "ivy", subject: "Q", time: T0 });
assert.equal(getPending("ivy", String(T0 + WINDOW)).payload.due, true);
assert.equal(getPending("ivy", "not-a-number").payload.field, "time");

// A mutated response must not corrupt stored state.
const snapshot = getPending("ivy", T0 + 1);
snapshot.payload.notifications[0].subject = "tampered";
assert.equal(getPending("ivy", T0 + 1).payload.notifications[0].subject, "Q");
flush({ recipient: "ivy", time: T0 + WINDOW });
const stored = getDigests("ivy");
stored.payload.digests[0].notifications[0].subject = "tampered";
stored.payload.digests[0].reason = "urgent";
assert.equal(getDigests("ivy").payload.digests[0].notifications[0].subject, "Q");
assert.equal(getDigests("ivy").payload.digests[0].reason, "window_elapsed");

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------
resetState();
assert.equal(handleRequest("GET", "/policy").status, 200);
assert.equal(
  handleRequest("POST", "/notify", { recipient: "routed", subject: "R1", time: T0 }).status,
  201,
);
assert.equal(
  handleRequest("GET", "/pending", undefined, { recipient: "routed", time: String(T0) }).payload
    .count,
  1,
);
assert.equal(
  handleRequest("POST", "/flush", { recipient: "routed", time: String(T0) }).payload.field,
  "time",
  "a POST body carries a real number; a string is not coerced",
);
assert.equal(
  handleRequest("POST", "/flush", { recipient: "routed", time: T0 + WINDOW }).payload.digest.count,
  1,
);
assert.equal(handleRequest("GET", "/digests", undefined, { recipient: "routed" }).payload.count, 1);
assert.equal(handleRequest("GET", "/digests", undefined, {}).status, 200);
assert.equal(handleRequest("POST", "/pending", {}).status, 404);
assert.equal(handleRequest("GET", "/notify", undefined, {}).status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

// resetState clears buffers and emitted digests alike.
resetState();
assert.equal(getDigests().payload.count, 0);
assert.equal(getPending("routed", T0).payload.count, 0);

console.log(
  "PASS: /notify buffers against a window anchored to the first arrival, /flush batches it into one digest when due, and urgent notifications emit on arrival",
);
