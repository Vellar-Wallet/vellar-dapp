// Mock balance lookup routes: one account by path parameter, or many accounts
// in a single batch request. Balances come from a fixed in-memory fixture —
// no chain, RPC or database access.
import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_SIZE = 50;

/** Fixed sample ledger. Keys are account ids; values are the balances that
 * account holds, ordered most-significant asset first. */
const ACCOUNTS = {
  GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB: [
    { assetCode: "XLM", balance: "1250.5000000" },
    { assetCode: "USDC", balance: "310.0000000" },
  ],
  GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF: [
    { assetCode: "XLM", balance: "0.5000000" },
  ],
  GHIJ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF: [
    { assetCode: "XLM", balance: "42.0000000" },
    { assetCode: "USDC", balance: "0.0000000" },
    { assetCode: "EURC", balance: "18.7500000" },
  ],
};

/**
 * Looks up one account. Returns `null` when the account is unknown so callers
 * can decide between a 404 (single lookup) and a per-item miss (batch).
 */
export function lookupAccount(accountId) {
  const balances = ACCOUNTS[accountId];
  if (!balances) {
    return null;
  }
  // Copied so a caller mutating the response can't corrupt the fixture.
  return { accountId, balances: balances.map((b) => ({ ...b })) };
}

/**
 * Resolves a list of account ids, preserving request order and reporting
 * misses per item rather than failing the whole batch.
 */
export function lookupBatch(accountIds) {
  if (!Array.isArray(accountIds)) {
    return { status: 400, body: { error: "account_ids_required" } };
  }
  if (accountIds.length === 0) {
    return { status: 400, body: { error: "account_ids_empty" } };
  }
  if (accountIds.length > MAX_BATCH_SIZE) {
    return {
      status: 400,
      body: { error: "batch_too_large", maxBatchSize: MAX_BATCH_SIZE },
    };
  }
  if (accountIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    return { status: 400, body: { error: "invalid_account_id" } };
  }

  const results = accountIds.map((id) => {
    const account = lookupAccount(id.trim());
    return account
      ? { accountId: id.trim(), found: true, balances: account.balances }
      : { accountId: id.trim(), found: false, balances: [] };
  });

  return {
    status: 200,
    body: {
      results,
      requested: results.length,
      found: results.filter((r) => r.found).length,
    },
  };
}

/** Collects the request body, rejecting anything larger than MAX_BODY_BYTES
 * so a runaway client can't grow the buffer without bound. */
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        tooLarge = true;
      }
    });
    req.on("end", () => resolve(tooLarge ? { tooLarge: true } : { raw: data }));
  });
}

export async function handleRequest(req) {
  const path = new URL(req.url, "http://localhost").pathname;

  if (path === "/balances/batch") {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }

    const { raw, tooLarge } = await readBody(req);
    if (tooLarge) {
      return { status: 413, body: { error: "body_too_large" } };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw === "" ? "null" : raw);
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 400, body: { error: "invalid_body" } };
    }

    return lookupBatch(parsed.accountIds);
  }

  // Single lookup: /balances/:accountId — matched after the batch path so
  // "batch" is never treated as an account id.
  const single = /^\/balances\/([^/]+)$/.exec(path);
  if (single) {
    if (req.method !== "GET") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    const accountId = decodeURIComponent(single[1]);
    const account = lookupAccount(accountId);
    if (!account) {
      return { status: 404, body: { error: "account_not_found", accountId } };
    }
    return { status: 200, body: account };
  }

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const { status, body } = await handleRequest(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4055;
  server.listen(port, () => {
    console.log(`balance-lookup mock listening on http://localhost:${port}`);
    console.log(`  GET  /balances/:accountId`);
    console.log(`  POST /balances/batch`);
  });
}
