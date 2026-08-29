import assert from "node:assert/strict";
import http from "node:http";
import { checkHealth, checkWalletCreate, runSmokeTest, targetsFromEnv, DEFAULT_TARGETS } from "./route.mjs";

// Spins up a real in-process HTTP server per test so checkHealth/checkWalletCreate/
// runSmokeTest exercise their actual fetch + timeout logic against a real
// socket, not a hand-rolled fake fetch.
function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: "http://127.0.0.1" });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// --- targetsFromEnv --------------------------------------------------------

{
  assert.deepEqual(targetsFromEnv({}), DEFAULT_TARGETS);
  assert.deepEqual(
    targetsFromEnv({ SMOKE_TARGETS: JSON.stringify([{ name: "x", port: 9999 }]) }),
    [{ name: "x", port: 9999 }],
  );
  // Malformed override falls back to defaults rather than silently running
  // zero checks.
  assert.deepEqual(targetsFromEnv({ SMOKE_TARGETS: "{not valid json" }), DEFAULT_TARGETS);
  assert.deepEqual(targetsFromEnv({ SMOKE_TARGETS: "[]" }), DEFAULT_TARGETS);
}

// --- checkHealth: healthy service --------------------------------------

{
  const { server, port, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "test-svc" }));
  });
  const result = await checkHealth(baseUrl, { name: "test-svc", port });
  assert.equal(result.ok, true);
  assert.equal(result.check, "health");
  await closeServer(server);
}

// --- checkHealth: 503 unavailable (matches registerHealth's readiness-fail shape) -

{
  const { server, port, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "unavailable", service: "test-svc" }));
  });
  const result = await checkHealth(baseUrl, { name: "test-svc", port });
  assert.equal(result.ok, false);
  assert.match(result.detail, /503/);
  await closeServer(server);
}

// --- checkHealth: connection refused (service not running at all) --------

{
  // Nothing listening on this port.
  const result = await checkHealth("http://127.0.0.1", { name: "down-svc", port: 1 }, { timeoutMs: 1000 });
  assert.equal(result.ok, false);
}

// --- checkHealth: timeout on a hanging service --------------------------

{
  const { server, port, baseUrl } = await startMockServer((_req, _res) => {
    // Never respond — simulates a hung service.
  });
  const start = Date.now();
  const result = await checkHealth(baseUrl, { name: "hung-svc", port }, { timeoutMs: 100 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.detail, /timed out/);
  assert.ok(elapsed < 2000, "must fail fast via timeout, not hang indefinitely");
  await closeServer(server);
}

// --- checkWalletCreate: success shape matches server.test.ts's real contract -

{
  const { server, port, baseUrl } = await startMockServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    assert.equal(body.keyId, "smoke-test-key");
    assert.equal(body.network, "testnet");
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ contractId: "C123", txHash: "h1", sessionId: "s1" }));
  });
  const result = await checkWalletCreate(baseUrl, { name: "wallet-service", port });
  assert.equal(result.ok, true);
  assert.match(result.detail, /s1/);
  await closeServer(server);
}

// --- checkWalletCreate: missing required fields fails ---------------------

{
  const { server, port, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ contractId: "C123" })); // missing txHash, sessionId
  });
  const result = await checkWalletCreate(baseUrl, { name: "wallet-service", port });
  assert.equal(result.ok, false);
  await closeServer(server);
}

// --- checkWalletCreate: non-201 status fails even with a well-shaped body -

{
  const { server, port, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ contractId: "C123", txHash: "h1", sessionId: "s1" }));
  });
  const result = await checkWalletCreate(baseUrl, { name: "wallet-service", port });
  assert.equal(result.ok, false);
  assert.match(result.detail, /500/);
  await closeServer(server);
}

// --- runSmokeTest: all services healthy -> passed, exit-worthy 0 ----------

{
  const { server, port, baseUrl } = await startMockServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "svc" }));
      return;
    }
    if (req.url === "/wallet/create") {
      await readBody(req);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ contractId: "C1", txHash: "h", sessionId: "s" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const targets = [
    { name: "api-gateway", port },
    { name: "wallet-service", port, walletCreateCheck: true },
  ];
  const { passed, results, failedCount } = await runSmokeTest({ baseUrl, targets });
  assert.equal(passed, true);
  assert.equal(failedCount, 0);
  // health for both targets + wallet-create for the flagged one = 3 checks
  assert.equal(results.length, 3);
  await closeServer(server);
}

// --- runSmokeTest: one service down -> fails, but ALL results still reported -

{
  const { server: upServer, port: upPort, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "up" }));
  });

  const targets = [
    { name: "healthy-svc", port: upPort },
    { name: "down-svc", port: 1 }, // nothing listening
  ];
  const { passed, results, failedCount } = await runSmokeTest({ baseUrl, targets, timeoutMs: 1000 });
  assert.equal(passed, false);
  assert.equal(failedCount, 1);
  // Both results present — a failure doesn't short-circuit the rest of the run.
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.name === "healthy-svc").ok, true);
  assert.equal(results.find((r) => r.name === "down-svc").ok, false);
  await closeServer(upServer);
}

// --- runSmokeTest: wallet-create e2e failure fails the whole run ----------

{
  const { server, port, baseUrl } = await startMockServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "svc" }));
      return;
    }
    await readBody(req);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "relayer not configured" }));
  });

  const targets = [{ name: "wallet-service", port, walletCreateCheck: true }];
  const { passed, failedCount } = await runSmokeTest({ baseUrl, targets });
  assert.equal(passed, false);
  assert.equal(failedCount, 1);
  await closeServer(server);
}

// --- runSmokeTest: mixed pass/fail across multiple targets summarizes all -

{
  const { server: healthyServer, port: healthyPort, baseUrl } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "healthy" }));
  });
  const { server: unhealthyServer, port: unhealthyPort } = await startMockServer((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "unavailable", service: "unhealthy" }));
  });

  const targets = [
    { name: "svc-a", port: healthyPort },
    { name: "svc-b", port: unhealthyPort },
    { name: "svc-c", port: 1 }, // down
  ];
  const { passed, failedCount, results } = await runSmokeTest({ baseUrl, targets, timeoutMs: 1000 });
  assert.equal(passed, false);
  assert.equal(failedCount, 2);
  assert.equal(results.length, 3);
  await closeServer(healthyServer);
  await closeServer(unhealthyServer);
}

console.log("PASS: Issue 339 pre-deploy smoke test tests passed cleanly!");
