import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

// Success: a valid payload is echoed back with a generated id.
const created = handleRequest({ limit: 500, windowSeconds: 86400 });
assert.equal(created.status, 201);
assert.match(created.body.id, /^pol_\d{4,}$/);
assert.equal(created.body.limit, 500);
assert.equal(created.body.windowSeconds, 86400);
assert.equal(created.body.type, "spending-limit");
assert.equal(created.body.label, null);
assert.equal(created.body.status, "active");
assert.equal(Number.isNaN(Date.parse(created.body.createdAt)), false);

// Optional fields are honoured when supplied.
const withOptionals = handleRequest({
  limit: 25.5,
  windowSeconds: 3600,
  type: "velocity",
  label: "hourly cap",
});
assert.equal(withOptionals.status, 201);
assert.equal(withOptionals.body.type, "velocity");
assert.equal(withOptionals.body.label, "hourly cap");
assert.equal(withOptionals.body.limit, 25.5);

// Each created policy gets a distinct id.
assert.notEqual(created.body.id, withOptionals.body.id);

// Validation failure: missing fields are reported per field.
assert.equal(handleRequest({ windowSeconds: 60 }).status, 400);
assert.equal(handleRequest({ windowSeconds: 60 }).body.error, "limit_required");
assert.equal(handleRequest({ limit: 10 }).body.error, "windowSeconds_required");

// Validation failure: zero and negative values are rejected.
assert.equal(handleRequest({ limit: 0, windowSeconds: 60 }).body.error, "limit_invalid");
assert.equal(handleRequest({ limit: 10, windowSeconds: -1 }).body.error, "windowSeconds_invalid");

// Validation failure: non-numeric values (including numeric strings) are rejected.
assert.equal(handleRequest({ limit: "500", windowSeconds: 60 }).body.error, "limit_invalid");
assert.equal(
  handleRequest({ limit: 10, windowSeconds: Number.NaN }).body.error,
  "windowSeconds_invalid",
);

// Validation failure: an unknown policy type is rejected.
const badType = handleRequest({ limit: 10, windowSeconds: 60, type: "nope" });
assert.equal(badType.status, 400);
assert.equal(badType.body.error, "invalid_type");

// Validation failure: a missing or non-object body is rejected rather than throwing.
assert.equal(handleRequest().body.error, "invalid_body");
assert.equal(handleRequest([]).body.error, "invalid_body");

console.log("PASS: POST /policies creates a record on valid input and 400s on invalid input");
