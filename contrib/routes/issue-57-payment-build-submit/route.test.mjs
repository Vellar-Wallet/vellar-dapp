import assert from "node:assert/strict";
import { handleBuild, handleSubmit, _resetDrafts } from "./route.mjs";

_resetDrafts();

// Build: success case.
const built = handleBuild({
  body: {
    recipient: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
    amount: "25.0000000",
    asset: "XLM",
  },
});
assert.equal(built.status, 200);
assert.equal(built.body.status, "built");
assert.ok(built.body.draftId.startsWith("draft_"));

// Build: missing required field.
const missingAmount = handleBuild({
  body: { recipient: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH", asset: "XLM" },
});
assert.equal(missingAmount.status, 400);
assert.equal(missingAmount.body.error, "invalid_request");
assert.deepEqual(missingAmount.body.missingFields, ["amount"]);

// Submit: unknown draft id returns a 404-style payload.
const unknownSubmit = handleSubmit({ draftId: "draft_does_not_exist" });
assert.equal(unknownSubmit.status, 404);
assert.equal(unknownSubmit.body.error, "draft_not_found");

// Full sequence: build then submit the same draft.
const draft = handleBuild({
  body: {
    recipient: "GXYZ9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA0987654321ZYXWVUTS",
    amount: "100.5000000",
    asset: "USDC",
  },
});
assert.equal(draft.status, 200);

const submitted = handleSubmit({ draftId: draft.body.draftId });
assert.equal(submitted.status, 200);
assert.equal(submitted.body.status, "submitted");
assert.equal(submitted.body.draftId, draft.body.draftId);
assert.match(submitted.body.txHash, /^[0-9a-f]{64}$/);

// Submitting the same draft again is rejected, not silently re-submitted.
const resubmitted = handleSubmit({ draftId: draft.body.draftId });
assert.equal(resubmitted.status, 409);
assert.equal(resubmitted.body.error, "already_submitted");
assert.equal(resubmitted.body.txHash, submitted.body.txHash);

console.log("PASS: payment build-then-submit flow (success, validation, 404, idempotency)");
