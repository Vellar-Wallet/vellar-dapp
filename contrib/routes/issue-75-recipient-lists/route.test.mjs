import assert from "node:assert/strict";
import { handleAdd, handleCheck } from "./route.mjs";

const ALLOWED = "GA111ALLOWEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const DENIED = "GB222DENIEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const UNLISTED = "GC333UNLISTEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

// Pre-seeded allowed recipient is reported as being on the allow list.
const allowed = handleCheck({ recipient: ALLOWED });
assert.equal(allowed.status, 200);
assert.equal(allowed.body.list, "allow");

// Pre-seeded denied recipient is reported as being on the deny list.
const denied = handleCheck({ recipient: DENIED });
assert.equal(denied.status, 200);
assert.equal(denied.body.list, "deny");

// A recipient not on either list reports list: null.
const unlisted = handleCheck({ recipient: UNLISTED });
assert.equal(unlisted.status, 200);
assert.equal(unlisted.body.list, null);

// Adding the unlisted recipient to the deny list, then it shows up on check.
const added = handleAdd({ type: "deny", recipient: UNLISTED });
assert.equal(added.status, 200);
assert.equal(added.body.type, "deny");

const afterAdd = handleCheck({ recipient: UNLISTED });
assert.equal(afterAdd.body.list, "deny");

// Missing recipient/type are rejected.
assert.equal(handleAdd({ type: "deny" }).status, 400);
assert.equal(handleAdd({ recipient: UNLISTED, type: "bogus" }).status, 400);
assert.equal(handleCheck({}).status, 400);

console.log("PASS: /recipient-lists add/check handle allow, deny, and unlisted recipients");
