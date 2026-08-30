import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const ACCOUNT_A = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB";
const ACCOUNT_B = "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF";
const UNKNOWN = "GZZZ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF";

/** Minimal stand-in for an http.IncomingMessage carrying a JSON body. */
function makeReq(method, url, body) {
  return {
    url,
    method,
    on: (event, cb) => {
      if (event === "data" && body !== undefined) cb(JSON.stringify(body));
      if (event === "end") cb();
    },
  };
}

// --- single lookup ---------------------------------------------------------

// Known account returns its balances.
{
  const { status, body } = await handleRequest(
    makeReq("GET", `/balances/${ACCOUNT_A}`),
  );

  assert.equal(status, 200);
  assert.equal(body.accountId, ACCOUNT_A);
  assert.equal(body.balances.length, 2);
  assert.equal(body.balances[0].assetCode, "XLM");
  assert.equal(typeof body.balances[0].balance, "string");
}

// Unknown account is a 404, and the id is echoed back.
{
  const { status, body } = await handleRequest(
    makeReq("GET", `/balances/${UNKNOWN}`),
  );

  assert.equal(status, 404);
  assert.equal(body.error, "account_not_found");
  assert.equal(body.accountId, UNKNOWN);
}

// The response is a copy: mutating it must not corrupt the fixture.
{
  const first = await handleRequest(makeReq("GET", `/balances/${ACCOUNT_A}`));
  first.body.balances[0].balance = "0";
  const second = await handleRequest(makeReq("GET", `/balances/${ACCOUNT_A}`));

  assert.equal(second.body.balances[0].balance, "1250.5000000");
}

// --- batch lookup ----------------------------------------------------------

// Mixed batch: results keep request order and misses are reported per item.
{
  const { status, body } = await handleRequest(
    makeReq("POST", "/balances/batch", {
      accountIds: [ACCOUNT_B, UNKNOWN, ACCOUNT_A],
    }),
  );

  assert.equal(status, 200);
  assert.equal(body.requested, 3);
  assert.equal(body.found, 2);
  assert.deepEqual(
    body.results.map((r) => r.accountId),
    [ACCOUNT_B, UNKNOWN, ACCOUNT_A],
  );
  assert.deepEqual(
    body.results.map((r) => r.found),
    [true, false, true],
  );
  assert.deepEqual(body.results[1].balances, []);
  assert.equal(body.results[2].balances.length, 2);
}

// A single-element batch matches the single-lookup response for that account.
{
  const batch = await handleRequest(
    makeReq("POST", "/balances/batch", { accountIds: [ACCOUNT_A] }),
  );
  const single = await handleRequest(makeReq("GET", `/balances/${ACCOUNT_A}`));

  assert.deepEqual(batch.body.results[0].balances, single.body.balances);
}

// Validation: missing, empty, oversized and malformed inputs.
{
  const missing = await handleRequest(makeReq("POST", "/balances/batch", {}));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "account_ids_required");

  const empty = await handleRequest(
    makeReq("POST", "/balances/batch", { accountIds: [] }),
  );
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, "account_ids_empty");

  const tooMany = await handleRequest(
    makeReq("POST", "/balances/batch", {
      accountIds: Array.from({ length: 51 }, (_, i) => `G${i}`),
    }),
  );
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, "batch_too_large");
  assert.equal(tooMany.body.maxBatchSize, 50);

  const badEntry = await handleRequest(
    makeReq("POST", "/balances/batch", { accountIds: [ACCOUNT_A, ""] }),
  );
  assert.equal(badEntry.status, 400);
  assert.equal(badEntry.body.error, "invalid_account_id");
}

// Routing guards: wrong methods and unknown paths.
{
  const wrongBatchMethod = await handleRequest(
    makeReq("GET", "/balances/batch"),
  );
  assert.equal(wrongBatchMethod.status, 405);

  const wrongSingleMethod = await handleRequest(
    makeReq("POST", `/balances/${ACCOUNT_A}`, {}),
  );
  assert.equal(wrongSingleMethod.status, 405);

  const unknownPath = await handleRequest(makeReq("GET", "/nope"));
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.body.error, "not_found");
}

console.log("PASS: GET /balances/:accountId and POST /balances/batch");
