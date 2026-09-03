import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const { status, body } = handleRequest();

assert.equal(status, 200);
assert.equal(typeof body.balance, "string");
assert.equal(typeof body.assetCode, "string");
assert.equal(body.assetCode, "XLM");

console.log("PASS: /wallet-balance returns balance + assetCode");
