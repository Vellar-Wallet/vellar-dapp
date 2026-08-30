import assert from "node:assert/strict";
import { handleRequest, SAMPLE_TRANSACTIONS } from "./route.mjs";

const TRANSACTIONS = [
  { id: "tx_a", amount: "25.0000000", asset: "XLM", recipient: "GAAA", memo: "rent" },
  { id: "tx_b", amount: "900.0000000", asset: "XLM", recipient: "GAAA", memo: "payroll" },
  { id: "tx_c", amount: "10.0000000", asset: "USDC", recipient: "GBBB", memo: "" },
];

// A maxAmount policy rejects the one transaction over the cap and passes the
// rest, reporting why.
const capped = handleRequest({
  body: { policy: { maxAmount: 100 }, transactions: TRANSACTIONS },
});
assert.equal(capped.status, 200);
assert.equal(capped.body.persisted, false);
assert.deepEqual(capped.body.summary, { simulated: 3, passed: 2, failed: 1 });
assert.deepEqual(
  capped.body.results.map((r) => r.decision),
  ["pass", "fail", "pass"],
);

const rejected = capped.body.results[1];
assert.equal(rejected.id, "tx_b");
assert.equal(rejected.index, 1);
assert.equal(rejected.violations.length, 1);
assert.equal(rejected.violations[0].rule, "maxAmount");
assert.match(rejected.violations[0].reason, /exceeds maxAmount/);

// Passing transactions carry an empty violations array, not a missing key.
assert.deepEqual(capped.body.results[0].violations, []);

// Several rules at once: every violation on a transaction is reported, not
// just the first one to trip.
const strict = handleRequest({
  body: {
    policy: { maxAmount: 100, allowedAssets: ["XLM"], allowedRecipients: ["GAAA"] },
    transactions: TRANSACTIONS,
  },
});
assert.deepEqual(strict.body.summary, { simulated: 3, passed: 1, failed: 2 });
assert.deepEqual(
  strict.body.results[2].violations.map((v) => v.rule).sort(),
  ["allowedAssets", "allowedRecipients"],
);

// requireMemo treats a blank memo as missing.
const memoed = handleRequest({
  body: { policy: { requireMemo: true }, transactions: TRANSACTIONS },
});
assert.deepEqual(memoed.body.summary, { simulated: 3, passed: 2, failed: 1 });
assert.equal(memoed.body.results[2].violations[0].rule, "requireMemo");

// An empty policy has nothing to enforce, so everything passes.
const permissive = handleRequest({ body: { policy: {}, transactions: TRANSACTIONS } });
assert.deepEqual(permissive.body.summary, { simulated: 3, passed: 3, failed: 0 });

// An empty transaction list is a valid, if uninteresting, simulation.
const nothing = handleRequest({ body: { policy: { maxAmount: 1 }, transactions: [] } });
assert.equal(nothing.status, 200);
assert.deepEqual(nothing.body.summary, { simulated: 0, passed: 0, failed: 0 });

// Omitting transactions falls back to the built-in sample set.
const defaulted = handleRequest({ body: { policy: { maxAmount: 100 } } });
assert.equal(defaulted.body.summary.simulated, SAMPLE_TRANSACTIONS.length);
assert.ok(defaulted.body.summary.failed > 0);

// A misspelled rule is rejected rather than ignored, so the dry run can never
// report a clean pass for a policy that enforces nothing.
const typo = handleRequest({
  body: { policy: { maxAmmount: 100 }, transactions: TRANSACTIONS },
});
assert.equal(typo.status, 400);
assert.equal(typo.body.error, "unsupported_rule");
assert.deepEqual(typo.body.unsupportedRules, ["maxAmmount"]);

// Malformed input is rejected before any simulation happens.
assert.equal(handleRequest({ body: {} }).status, 400);
assert.equal(handleRequest({ body: { policy: {}, transactions: "nope" } }).status, 400);
assert.equal(handleRequest({ body: { policy: {}, transactions: [null] } }).status, 400);

// The simulation is read-only: the caller's inputs come back untouched.
const before = JSON.stringify(TRANSACTIONS);
handleRequest({ body: { policy: { maxAmount: 1 }, transactions: TRANSACTIONS } });
assert.equal(JSON.stringify(TRANSACTIONS), before);

console.log("PASS: /policy/dry-run reports pass and fail per sample transaction");
