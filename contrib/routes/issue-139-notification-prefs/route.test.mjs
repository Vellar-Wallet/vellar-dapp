import assert from "node:assert/strict";
import { handleGet, handleUpdate, _resetPrefs } from "./route.mjs";

_resetPrefs();

// Get: account never explicitly configured returns default preferences.
const defaults = handleGet("acct_new");
assert.equal(defaults.status, 200);
assert.deepEqual(defaults.body.preferences, { email: true, push: true, sms: false, marketing: false });

// Update: missing account id.
const missingAccount = handleUpdate(undefined, { sms: true });
assert.equal(missingAccount.status, 400);
assert.equal(missingAccount.body.error, "account_id_required");

// Update: unknown field is rejected.
const badField = handleUpdate("acct_new", { carrierPigeon: true });
assert.equal(badField.status, 400);
assert.equal(badField.body.error, "invalid_field");

// Update: partial update only changes the fields provided, others unchanged.
const updated = handleUpdate("acct_new", { sms: true });
assert.equal(updated.status, 200);
assert.deepEqual(updated.body.preferences, { email: true, push: true, sms: true, marketing: false });

// Get after partial update reflects the merged state, not just the change.
const afterUpdate = handleGet("acct_new");
assert.deepEqual(afterUpdate.body.preferences, { email: true, push: true, sms: true, marketing: false });

// A second partial update layers on top of the first without reverting it.
const secondUpdate = handleUpdate("acct_new", { marketing: true });
assert.deepEqual(secondUpdate.body.preferences, { email: true, push: true, sms: true, marketing: true });

// A different account is unaffected by the first account's updates.
const otherAccount = handleGet("acct_other");
assert.deepEqual(otherAccount.body.preferences, { email: true, push: true, sms: false, marketing: false });

console.log("PASS: notification preferences default and partial-update-preserves-others behave as expected");
