import assert from "node:assert/strict";
import { recordSpend, getWindow, resetAccount, resetState, handleRequest } from "./route.mjs";

const T0 = 1_700_000_000_000; // fixed epoch ms so every window boundary is exact
const WINDOW_MS = 60_000;
const LIMIT = 1000;
const ACCOUNT = "GA_SPENDER";

resetState();

// A fresh account has no window at all.
let view = getWindow({ account: ACCOUNT, now: T0 });
assert.equal(view.status, 200);
assert.equal(view.payload.active, false);
assert.equal(view.payload.elapsed, false);
assert.equal(view.payload.spent, 0);
assert.equal(view.payload.remaining, LIMIT);
assert.equal(view.payload.windowStartedAt, null);

// The first spend opens the window and anchors it at that instant.
let spend = recordSpend({ account: ACCOUNT, amount: 400, now: T0 });
assert.equal(spend.status, 200);
assert.equal(spend.payload.spent, 400);
assert.equal(spend.payload.remaining, 600);
assert.equal(spend.payload.windowStartedAt, T0);
assert.equal(spend.payload.windowEndsAt, T0 + WINDOW_MS);
assert.equal(spend.payload.windowReset, false); // first ever window, not a reset

// A second spend inside the window accumulates against the same total and does
// NOT re-anchor the window.
spend = recordSpend({ account: ACCOUNT, amount: 350, now: T0 + 10_000 });
assert.equal(spend.payload.spent, 750);
assert.equal(spend.payload.remaining, 250);
assert.equal(spend.payload.windowStartedAt, T0, "window must not slide on each spend");
assert.equal(spend.payload.spendCount, 2);
assert.equal(spend.payload.msRemaining, WINDOW_MS - 10_000);

// A spend that would cross the limit is refused with 429.
const refused = recordSpend({ account: ACCOUNT, amount: 300, now: T0 + 20_000 });
assert.equal(refused.status, 429);
assert.equal(refused.payload.error, "limit_exceeded");
assert.equal(refused.payload.attempted, 300);
assert.equal(refused.payload.wouldBeSpent, 1050);
assert.equal(refused.payload.spent, 750);

// ...and the refusal recorded nothing: the total and the anchor are untouched.
view = getWindow({ account: ACCOUNT, now: T0 + 20_000 });
assert.equal(view.payload.spent, 750);
assert.equal(view.payload.spendCount, 2);
assert.equal(view.payload.windowStartedAt, T0);

// A spend that exactly reaches the limit is allowed; remaining hits zero.
spend = recordSpend({ account: ACCOUNT, amount: 250, now: T0 + 30_000 });
assert.equal(spend.status, 200);
assert.equal(spend.payload.spent, LIMIT);
assert.equal(spend.payload.remaining, 0);

// With the window full, even the smallest spend is refused until it elapses.
assert.equal(recordSpend({ account: ACCOUNT, amount: 1, now: T0 + 31_000 }).status, 429);

// One millisecond before the boundary the window is still live and still full.
view = getWindow({ account: ACCOUNT, now: T0 + WINDOW_MS - 1 });
assert.equal(view.payload.active, true);
assert.equal(view.payload.spent, LIMIT);
assert.equal(view.payload.msRemaining, 1);
assert.equal(recordSpend({ account: ACCOUNT, amount: 1, now: T0 + WINDOW_MS - 1 }).status, 429);

// Exactly at the boundary the window has elapsed. Reading reports it as
// elapsed and inactive with a zero total...
view = getWindow({ account: ACCOUNT, now: T0 + WINDOW_MS });
assert.equal(view.payload.active, false);
assert.equal(view.payload.elapsed, true);
assert.equal(view.payload.spent, 0);
assert.equal(view.payload.remaining, LIMIT);

// ...but reading must not have committed the reset. The next spend is what
// opens the new window, and it re-anchors to its own timestamp, not to the
// boundary and not to the read.
spend = recordSpend({ account: ACCOUNT, amount: 900, now: T0 + WINDOW_MS + 5_000 });
assert.equal(spend.status, 200);
assert.equal(spend.payload.windowReset, true);
assert.equal(spend.payload.spent, 900, "the elapsed window's total must not carry over");
assert.equal(spend.payload.remaining, 100);
assert.equal(spend.payload.spendCount, 1, "the elapsed window's spends must not carry over");
assert.equal(spend.payload.windowStartedAt, T0 + WINDOW_MS + 5_000);
assert.equal(spend.payload.windowEndsAt, T0 + 2 * WINDOW_MS + 5_000);

// The new window enforces the limit on its own terms.
assert.equal(
  recordSpend({ account: ACCOUNT, amount: 200, now: T0 + WINDOW_MS + 6_000 }).status,
  429,
);
spend = recordSpend({ account: ACCOUNT, amount: 100, now: T0 + WINDOW_MS + 6_000 });
assert.equal(spend.payload.spent, LIMIT);
assert.equal(spend.payload.windowReset, false, "still the same window as the reset spend");

// A window may elapse with no spend attempt in it at all — skipping several
// window lengths still resets exactly once, to the spend's own anchor.
spend = recordSpend({ account: ACCOUNT, amount: 50, now: T0 + 10 * WINDOW_MS });
assert.equal(spend.payload.windowReset, true);
assert.equal(spend.payload.spent, 50);
assert.equal(spend.payload.windowStartedAt, T0 + 10 * WINDOW_MS);

// Accounts are tracked independently.
resetState();
recordSpend({ account: "GA_ONE", amount: 900, now: T0 });
recordSpend({ account: "GA_TWO", amount: 100, now: T0 });
assert.equal(getWindow({ account: "GA_ONE", now: T0 }).payload.spent, 900);
assert.equal(getWindow({ account: "GA_TWO", now: T0 }).payload.spent, 100);
assert.equal(recordSpend({ account: "GA_ONE", amount: 200, now: T0 }).status, 429);
assert.equal(recordSpend({ account: "GA_TWO", amount: 200, now: T0 }).status, 200);

// Reset drops the window outright and reports whether one existed.
let cleared = resetAccount({ account: "GA_ONE" });
assert.equal(cleared.status, 200);
assert.equal(cleared.payload.cleared, true);
assert.equal(getWindow({ account: "GA_ONE", now: T0 }).payload.active, false);
assert.equal(recordSpend({ account: "GA_ONE", amount: 900, now: T0 }).status, 200);
assert.equal(resetAccount({ account: "GA_NEVER_SPENT" }).payload.cleared, false);

// Validation.
assert.equal(recordSpend({ amount: 10, now: T0 }).payload.error, "account_required");
assert.equal(recordSpend({ account: " ", amount: 10, now: T0 }).payload.error, "account_required");
assert.equal(recordSpend({ account: ACCOUNT, amount: 0, now: T0 }).payload.error, "invalid_amount");
assert.equal(
  recordSpend({ account: ACCOUNT, amount: -5, now: T0 }).payload.error,
  "invalid_amount",
);
assert.equal(
  recordSpend({ account: ACCOUNT, amount: "10", now: T0 }).payload.error,
  "invalid_amount",
);
assert.equal(
  recordSpend({ account: ACCOUNT, amount: NaN, now: T0 }).payload.error,
  "invalid_amount",
);
assert.equal(
  recordSpend({ account: ACCOUNT, amount: 10, now: "soon" }).payload.error,
  "invalid_now",
);
assert.equal(getWindow({ account: ACCOUNT, now: NaN }).payload.error, "invalid_now");
assert.equal(getWindow({}).payload.error, "account_required");

// Time running backwards inside a live window is refused rather than silently
// producing a negative elapsed span.
resetState();
recordSpend({ account: ACCOUNT, amount: 10, now: T0 });
const backwards = recordSpend({ account: ACCOUNT, amount: 10, now: T0 - 1_000 });
assert.equal(backwards.status, 400);
assert.equal(backwards.payload.error, "now_before_window_start");
assert.equal(backwards.payload.windowStartedAt, T0);

// Routing.
resetState();
assert.equal(
  handleRequest("POST", "/spend", { account: ACCOUNT, amount: 10, now: T0 }).status,
  200,
);
// Query strings arrive as strings; `now` must still be read as a number.
const routed = handleRequest("GET", "/window", undefined, { account: ACCOUNT, now: String(T0) });
assert.equal(routed.status, 200);
assert.equal(routed.payload.spent, 10);
assert.equal(routed.payload.windowStartedAt, T0);
assert.equal(handleRequest("POST", "/reset", { account: ACCOUNT }).payload.cleared, true);
assert.equal(handleRequest("GET", "/spend", undefined, {}).status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

console.log(
  "PASS: /spend accumulates inside an anchored window, refuses over-limit spends without recording them, and resets the window once it elapses",
);
