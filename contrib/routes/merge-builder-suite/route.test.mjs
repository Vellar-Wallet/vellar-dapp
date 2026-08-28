import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const VALID_DEST = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB";
const INVALID_DEST = "INVALIDACCOUNT";

function makeReq(method, url, body) {
  const readable = {
    url,
    method,
    on: (event, cb) => {
      if (event === "data") cb(JSON.stringify(body || {}));
      if (event === "end") cb();
    },
  };
  return readable;
}

// Test validate-destination with valid destination
{
  const req = makeReq("POST", "/validate-destination", {
    destination: VALID_DEST,
  });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.valid, true);
}

// Test validate-destination with invalid destination
{
  const req = makeReq("POST", "/validate-destination", {
    destination: INVALID_DEST,
  });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 400);
  assert.equal(body.valid, false);
  assert.equal(body.error, "invalid_destination");
}

// Test build with valid destination
{
  const req = makeReq("POST", "/build", { destination: VALID_DEST });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.txReady, true);
  assert.equal(body.destination, VALID_DEST);
}

// Test build refuses invalid destination
{
  const req = makeReq("POST", "/build", { destination: INVALID_DEST });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 400);
  assert.equal(body.valid, false);
}

// Test estimate-reclaim
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: "/estimate-reclaim",
  });
  assert.equal(status, 200);
  assert.equal(body.sourceBalance, "1250.5000000");
  assert.equal(body.reserve, "1.0000000");
  assert.equal(body.estimatedReclaim, "1249.5000000");
}

console.log("PASS: merge-builder-suite tests");
