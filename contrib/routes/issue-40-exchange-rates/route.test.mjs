import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

let { status, body } = handleRequest();
assert.equal(status, 200);
assert.ok(Array.isArray(body.rates));
assert.ok(body.rates.length >= 4);
for (const r of body.rates) {
  assert.equal(typeof r.base, "string");
  assert.equal(typeof r.quote, "string");
  assert.equal(typeof r.rate, "string");
}

({ status, body } = handleRequest("/exchange-rates?base=XLM"));
assert.equal(status, 200);
assert.ok(body.rates.every((r) => r.base === "XLM"));
assert.ok(body.rates.length >= 2);

({ status, body } = handleRequest("/exchange-rates?base=BTC"));
assert.equal(status, 200);
assert.ok(body.rates.every((r) => r.base === "BTC"));

console.log("PASS: /exchange-rates returns rates and filters by base");
