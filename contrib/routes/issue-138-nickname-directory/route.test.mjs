import assert from "node:assert/strict";
import { handleAdd, handleLookup, handleRemove, _resetDirectory } from "./route.mjs";

_resetDirectory();

// Add: missing nickname.
const missingNickname = handleAdd({ address: "GB000XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" });
assert.equal(missingNickname.status, 400);
assert.equal(missingNickname.body.error, "nickname_required");

// Add: missing address.
const missingAddress = handleAdd({ nickname: "bob" });
assert.equal(missingAddress.status, 400);
assert.equal(missingAddress.body.error, "address_required");

// Add: success.
const added = handleAdd({ nickname: "bob", address: "GB222BOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" });
assert.equal(added.status, 200);
assert.equal(added.body.added, true);

// Lookup: found.
const found = handleLookup("bob");
assert.equal(found.status, 200);
assert.equal(found.body.address, "GB222BOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// Lookup: unknown nickname returns 404 style payload.
const notFound = handleLookup("nobody");
assert.equal(notFound.status, 404);
assert.equal(notFound.body.error, "nickname_not_found");

// Add: duplicate nickname is rejected with a clear error.
const duplicate = handleAdd({ nickname: "bob", address: "GC333OTHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" });
assert.equal(duplicate.status, 409);
assert.equal(duplicate.body.error, "nickname_exists");

// Remove: success.
const removed = handleRemove("bob");
assert.equal(removed.status, 200);
assert.equal(removed.body.removed, true);
assert.equal(handleLookup("bob").status, 404);

// Remove: unknown nickname.
const removeUnknown = handleRemove("nobody");
assert.equal(removeUnknown.status, 404);
assert.equal(removeUnknown.body.error, "nickname_not_found");

console.log("PASS: nickname directory add, lookup, and duplicate rejection behave as expected");
