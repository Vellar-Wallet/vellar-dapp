import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

let { status, body } = handleRequest({ memo: "hello", type: "text" });
assert.equal(status, 200);
assert.equal(body.valid, true);

({ status, body } = handleRequest({ memo: "a".repeat(29) }));
assert.equal(status, 400);
assert.equal(body.error, "memo_too_long");

({ status, body } = handleRequest({ memo: "test", type: "invalid" }));
assert.equal(status, 400);
assert.equal(body.error, "invalid_memo_type");

({ status, body } = handleRequest());
assert.equal(status, 400);
assert.equal(body.error, "memo_required");

console.log("PASS: /memo-validate handles valid, too long, bad type, and missing");
