import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

resetState();

const created1 = handleRequest({ method: "POST", path: "/api-keys", body: { label: "ci" } });
assert.equal(created1.status, 201);
assert.equal(typeof created1.body.key, "string");
assert.ok(created1.body.key.startsWith("vlr_"));

const created2 = handleRequest({ method: "POST", path: "/api-keys", body: { label: "prod" } });
assert.equal(created2.status, 201);
assert.notEqual(created1.body.key, created2.body.key);

const { status, body } = handleRequest({ method: "GET", path: "/api-keys" });
assert.equal(status, 200);
assert.equal(body.keys.length, 2);

for (const key of body.keys) {
  assert.equal(typeof key.maskedKey, "string");
  assert.notEqual(key.maskedKey, created1.body.key);
  assert.notEqual(key.maskedKey, created2.body.key);
  assert.ok(key.maskedKey.includes("*"));
  assert.equal(key.fullKey, undefined);
}

const { status: badMethod } = handleRequest({ method: "DELETE", path: "/api-keys" });
assert.equal(badMethod, 405);

const { status: notFound } = handleRequest({ method: "GET", path: "/nope" });
assert.equal(notFound, 404);

console.log("PASS: /api-keys creates keys and lists them with masked values only");
