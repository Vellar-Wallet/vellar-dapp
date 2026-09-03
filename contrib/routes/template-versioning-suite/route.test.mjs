import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

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

// Test versions
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: "/versions",
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.versions));
  assert.ok(body.versions.includes("1.0"));
  assert.ok(body.versions.includes("2.0"));
  assert.equal(body.current, "2.0");
}

// Test current-config
{
  const { status, body } = await handleRequest({
    method: "GET",
    url: "/current-config",
  });
  assert.equal(status, 200);
  assert.equal(body.version, "2.0");
  assert.ok(Array.isArray(body.fields));
  assert.ok(body.fields.includes("policyName"));
}

// Test migrate from old version
{
  const req = makeReq("POST", "/migrate", {
    version: "1.0",
    name: "My Policy",
    signerLimit: 3,
    chain: "testnet",
  });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.migrated, true);
  assert.equal(body.config.version, "2.0");
  assert.equal(body.config.policyName, "My Policy");
  assert.equal(body.config.maxSigners, 3);
  assert.equal(body.config.network, "testnet");
  assert.equal(body.config.name, undefined);
}

// Test migrate no-op on current version
{
  const req = makeReq("POST", "/migrate", {
    version: "2.0",
    policyName: "Current",
    maxSigners: 5,
    network: "mainnet",
  });
  const { status, body } = await handleRequest(req);
  assert.equal(status, 200);
  assert.equal(body.migrated, false);
  assert.equal(body.reason, "already_current");
}

console.log("PASS: template-versioning-suite tests");
