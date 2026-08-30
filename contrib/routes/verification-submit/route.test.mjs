import assert from "node:assert/strict";
import { handleRequest, resetJobCounter } from "./route.mjs";

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

resetJobCounter();

// Success: a contractId is present, so a job id comes back.
{
  const req = makeReq("POST", "/verification/submit", {
    contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
  });
  const { status, body } = await handleRequest(req);

  assert.equal(status, 202);
  assert.equal(body.jobId, "vjob_000001");
  assert.equal(
    body.contractId,
    "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
  );
  assert.equal(body.status, "queued");
}

// Each submission gets a distinct job id.
{
  const req = makeReq("POST", "/verification/submit", { contractId: "CB2" });
  const { status, body } = await handleRequest(req);

  assert.equal(status, 202);
  assert.equal(body.jobId, "vjob_000002");
}

// Missing field: no contractId at all.
{
  const req = makeReq("POST", "/verification/submit", { name: "token" });
  const { status, body } = await handleRequest(req);

  assert.equal(status, 400);
  assert.equal(body.error, "contract_id_required");
  assert.equal(body.jobId, undefined);
}

// Present but blank contractId is rejected too.
{
  const req = makeReq("POST", "/verification/submit", { contractId: "   " });
  const { status, body } = await handleRequest(req);

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_contract_id");
}

// Malformed JSON is reported as such rather than crashing the handler.
{
  const req = {
    url: "/verification/submit",
    method: "POST",
    on: (event, cb) => {
      if (event === "data") cb("{not json");
      if (event === "end") cb();
    },
  };
  const { status, body } = await handleRequest(req);

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_json");
}

// Wrong method and unknown path are handled explicitly.
{
  const wrongMethod = await handleRequest(makeReq("GET", "/verification/submit"));
  assert.equal(wrongMethod.status, 405);

  const unknownPath = await handleRequest(makeReq("POST", "/nope", {}));
  assert.equal(unknownPath.status, 404);
}

console.log("PASS: POST /verification/submit success, validation and error cases");
