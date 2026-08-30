import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route: Withdrawal Approval Flow (Issue #144)
 *
 * Two things happen here: a withdrawal is requested, and the request is checked
 * against a configured threshold to decide whether a human has to look at it.
 *
 * The threshold decision is made once, at request time, and stored on the
 * record. Re-reading a request never re-evaluates it -- if the policy were to
 * change, a request already in flight keeps the rule it was admitted under,
 * which is the whole reason the threshold is echoed back on every response.
 *
 * Everything is in memory; no funds move and no network is touched.
 */

/** Stellar-style amounts: 7 decimal places, 1 stroop = 0.0000001. */
const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Parses a Stellar-style decimal amount into stroops.
 *
 * Amounts are compared as integers rather than floats on purpose: this is a
 * yes/no decision about money, and `0.1 + 0.2 > 0.3` is exactly the class of
 * rounding error that must never decide whether a withdrawal needs a human.
 *
 * Returns `null` for anything that is not a positive amount with at most 7
 * decimal places -- including `NaN`, `Infinity`, exponent notation and the
 * empty string, all of which `Number()` would otherwise wave through.
 */
export function parseAmount(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,7})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
  return stroops > 0n ? stroops : null;
}

/** Renders stroops back as a canonical 7-decimal string. */
export function formatAmount(stroops) {
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/**
 * The policy. A withdrawal *at* the threshold is still automatic; only an
 * amount strictly above it needs a human. The boundary is stated here rather
 * than left to the reader of the comparison.
 */
const THRESHOLD_STROOPS = parseAmount("500.0000000");

export const POLICY = Object.freeze({
  asset: "XLM",
  threshold: formatAmount(THRESHOLD_STROOPS),
  rule: "amount > threshold requires manual approval; amount == threshold does not",
});

/** requestId -> record */
const requests = new Map();

/** Clears every stored request. Exported for tests. */
export function resetState() {
  requests.clear();
}

function badRequest(field, reason, extra = {}) {
  return { status: 400, payload: { error: "invalid_request", field, reason, ...extra } };
}

/**
 * `GET /policy` -- the threshold currently in effect.
 *
 * Useful on its own: a caller can render "amounts over X need approval" without
 * having to submit a withdrawal to find out.
 */
export function getPolicy() {
  return { status: 200, payload: { ...POLICY } };
}

/**
 * `POST /request` -- submit a withdrawal.
 *
 * Validation is deliberately strict. An unparseable amount is a `400`, not a
 * silent `NaN` that would compare `false` against the threshold and slip
 * through as auto-approved.
 */
export function requestWithdrawal({ account, amount, reference } = {}) {
  if (typeof account !== "string" || account.trim() === "") {
    return badRequest("account", "must be a non-empty string");
  }
  if (reference !== undefined && typeof reference !== "string") {
    return badRequest("reference", "must be a string when provided");
  }

  const stroops = parseAmount(amount);
  if (stroops === null) {
    return badRequest("amount", "must be a positive decimal with at most 7 decimal places", {
      received: amount === undefined ? null : String(amount),
    });
  }

  const requiresApproval = stroops > THRESHOLD_STROOPS;
  const record = {
    id: crypto.randomUUID(),
    account: account.trim(),
    amount: formatAmount(stroops),
    asset: POLICY.asset,
    reference: reference ?? null,
    requiresApproval,
    // Two names for one fact would drift apart; `status` is derived from
    // `requiresApproval` here and nowhere else.
    status: requiresApproval ? "pending_approval" : "auto_approved",
    threshold: POLICY.threshold,
    requestedAt: new Date().toISOString(),
  };

  requests.set(record.id, record);
  return { status: 201, payload: { ...record } };
}

/**
 * `GET /status?id=<requestId>` -- does this withdrawal need a human?
 *
 * Returns a copy, so a caller mutating the response cannot rewrite the stored
 * decision.
 */
export function getStatus(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest("id", "must be a non-empty request id");
  }

  const record = requests.get(id);
  if (!record) {
    return { status: 404, payload: { error: "request_not_found", requested: id } };
  }

  return { status: 200, payload: { ...record } };
}

export function handleRequest(method, pathname, body, query) {
  if (method === "GET" && pathname === "/policy") return getPolicy();
  if (method === "GET" && pathname === "/status") return getStatus(query?.id);
  if (method === "POST" && pathname === "/request") return requestWithdrawal(body ?? {});
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4144;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const query = Object.fromEntries(url.searchParams);
      const { status, payload } = handleRequest(req.method, url.pathname, body, query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(PORT, () => {
    console.log(`withdrawal-approval mock listening on http://localhost:${PORT}/policy`);
  });
}
