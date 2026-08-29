import http from "node:http";

// Sandboxed reference implementation of issue #339 (pre-deploy smoke test
// script for the services workspace). See README.md for how the target list
// maps onto the real services/* ports and health/wallet-create contracts.

/** Default targets, matching root .env.example's documented ports.
 * permission-service is deliberately omitted — it's an empty stub with no
 * server today (services/permission-service/src/index.ts is `export {};`). */
export const DEFAULT_TARGETS = [
  { name: "api-gateway", port: 4000 },
  { name: "wallet-service", port: 4001, walletCreateCheck: true },
  { name: "lifecycle-service", port: 4002 },
  { name: "policy-service", port: 4003 },
  { name: "verification-service", port: 4004 },
  { name: "worker-service", port: 4005 },
];

export function targetsFromEnv(env = process.env) {
  if (env.SMOKE_TARGETS) {
    try {
      const parsed = JSON.parse(env.SMOKE_TARGETS);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to defaults on malformed override — never silently
      // run zero checks because of a typo'd env var.
    }
  }
  return DEFAULT_TARGETS;
}

const DEFAULT_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET {baseUrl}:{port}/health and assert the shared registerHealth() shape
 * (packages/service-kit/src/index.ts): 200 + { status: "ok", service }.
 * A 503 ({ status: "unavailable" }) is a real, meaningful failure — it means
 * the service is up but its readiness probe (e.g. DB connectivity) failed.
 */
export async function checkHealth(baseUrl, target, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetchWithTimeout } = {}) {
  const url = `${baseUrl}:${target.port}/health`;
  try {
    const res = await fetchImpl(url, { method: "GET" }, timeoutMs);
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (res.status !== 200 || body?.status !== "ok") {
      return {
        name: target.name,
        check: "health",
        ok: false,
        detail: `expected 200 {status:"ok"}, got ${res.status} ${JSON.stringify(body)}`,
      };
    }
    return { name: target.name, check: "health", ok: true, detail: `${res.status} ${body.status}` };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
    return { name: target.name, check: "health", ok: false, detail: reason };
  }
}

/**
 * POST {baseUrl}:{port}/wallet/create with a synthetic payload and assert the
 * real contract confirmed in services/wallet-service/src/server.test.ts:
 * 201 + { contractId, txHash, sessionId }. This is a shape/liveness e2e
 * check, not a real on-chain deploy.
 */
export async function checkWalletCreate(baseUrl, target, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetchWithTimeout } = {}) {
  const url = `${baseUrl}:${target.port}/wallet/create`;
  const payload = {
    keyId: "smoke-test-key",
    contractId: "CSMOKETESTACCOUNT00000000000000000000000000000000000000",
    network: "testnet",
    signedTx: "smoke-test-xdr",
  };
  try {
    const res = await fetchImpl(
      url,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
      timeoutMs,
    );
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const hasRequiredFields = body && "contractId" in body && "txHash" in body && "sessionId" in body;
    if (res.status !== 201 || !hasRequiredFields) {
      return {
        name: target.name,
        check: "wallet-create-e2e",
        ok: false,
        detail: `expected 201 {contractId,txHash,sessionId}, got ${res.status} ${JSON.stringify(body)}`,
      };
    }
    return { name: target.name, check: "wallet-create-e2e", ok: true, detail: `201, sessionId=${body.sessionId}` };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err));
    return { name: target.name, check: "wallet-create-e2e", ok: false, detail: reason };
  }
}

/**
 * Runs health checks for every target, plus the wallet-create e2e check for
 * any target flagged `walletCreateCheck: true`. Never stops at the first
 * failure — collects every result so the summary shows the full picture,
 * matching how a real CI smoke test should behave (one failing service
 * shouldn't hide a second, unrelated failure).
 */
export async function runSmokeTest({ baseUrl, targets, timeoutMs, fetchImpl } = {}) {
  const effectiveTargets = targets ?? DEFAULT_TARGETS;
  const effectiveBaseUrl = baseUrl ?? "http://localhost";

  const checks = [];
  for (const target of effectiveTargets) {
    checks.push(checkHealth(effectiveBaseUrl, target, { timeoutMs, fetchImpl }));
    if (target.walletCreateCheck) {
      checks.push(checkWalletCreate(effectiveBaseUrl, target, { timeoutMs, fetchImpl }));
    }
  }
  const results = await Promise.all(checks);
  const failed = results.filter((r) => !r.ok);
  return { results, passed: failed.length === 0, failedCount: failed.length };
}

function printSummary(results) {
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.name} (${r.check}) — ${r.detail}`);
  }
}

// --- CLI entrypoint ---------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.argv.includes("--demo")) {
    // Self-contained demo: spin up a mock server answering every target's
    // /health and wallet-service's /wallet/create, then run the real smoke
    // test against it end to end.
    const port = 4339;
    const server = http.createServer((req, res) => {
      let bodyStr = "";
      req.on("data", (chunk) => (bodyStr += chunk));
      req.on("end", () => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", service: "demo" }));
          return;
        }
        if (req.url === "/wallet/create" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ contractId: "CDEMO", txHash: "demo-hash", sessionId: "demo-session" }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });
    await new Promise((resolve) => server.listen(port, resolve));
    console.log(`[demo] mock services listening on :${port} for every target\n`);

    const demoTargets = DEFAULT_TARGETS.map((t) => ({ ...t, port }));
    const { results, passed } = await runSmokeTest({ baseUrl: "http://localhost", targets: demoTargets });
    printSummary(results);
    server.close();
    process.exit(passed ? 0 : 1);
  }

  const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost";
  const targets = targetsFromEnv(process.env);
  const timeoutMs = process.env.SMOKE_TIMEOUT_MS ? Number(process.env.SMOKE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  const { results, passed, failedCount } = await runSmokeTest({ baseUrl, targets, timeoutMs });
  printSummary(results);
  if (!passed) {
    console.error(`\n${failedCount} check(s) failed — deploy should NOT proceed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
  process.exit(0);
}
