import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Withdrawal Approval Chain With Limits (Issue #148)
 *
 * A withdrawal is routed through zero, one, or two levels of approval depending
 * on how large it is. Small amounts settle on submission; mid-size amounts need
 * an operator; large amounts need an operator and then compliance.
 *
 * Three rules carry the suite:
 *
 *   1. The tier is pinned at request time. A request already in flight keeps the
 *      chain it was admitted under, so re-reading it can never change how many
 *      approvals it needs.
 *   2. Levels are approved in order, and the caller does not choose which level
 *      it is approving -- the server derives the next pending one. There is no
 *      way to sign off on compliance before an operator has looked at it.
 *   3. Separation of duties: one person cannot approve two levels of the same
 *      request, even when they hold both roles.
 *
 * Everything is in memory; no funds move and no network is touched.
 */

/** Stellar-style amounts: 7 decimal places, 1 stroop = 0.0000001. */
const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Parses a Stellar-style decimal amount into stroops.
 *
 * Tier selection is a comparison against a limit, so amounts are compared as
 * integers rather than floats -- a rounding error here would move a withdrawal
 * into the wrong approval chain entirely.
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
 * The approval levels, in the order they must be cleared.
 *
 * `lead-erin` sits on both rosters. She may clear either level, but never both
 * on the same request -- which is what makes the separation-of-duties rule
 * load-bearing rather than a side effect of the rosters not overlapping.
 */
const LEVELS = [
  { level: 1, name: "operator", approvers: ["ops-anna", "ops-ben", "lead-erin"] },
  { level: 2, name: "compliance", approvers: ["comp-carla", "comp-dan", "lead-erin"] },
];

/**
 * Amount tiers, narrowest limit first. `limit` is inclusive: an amount exactly
 * at a tier's limit stays in that tier. The last tier is the open-ended one.
 */
const TIERS = [
  { id: "auto", limit: "500.0000000", levelsRequired: 0 },
  { id: "operator", limit: "5000.0000000", levelsRequired: 1 },
  { id: "dual", limit: null, levelsRequired: 2 },
];

const TIER_LIMITS = TIERS.map((tier) => ({
  ...tier,
  limitStroops: tier.limit === null ? null : parseAmount(tier.limit),
}));

/** The first tier whose inclusive limit covers this amount. */
function tierFor(stroops) {
  return TIER_LIMITS.find((tier) => tier.limitStroops === null || stroops <= tier.limitStroops);
}

/** requestId -> record */
const requests = new Map();

/** Clears every stored request. Exported for tests. */
export function resetState() {
  requests.clear();
}

function badRequest(field, reason, extra = {}) {
  return { status: 400, payload: { error: "invalid_request", field, reason, ...extra } };
}

function notFound(id) {
  return { status: 404, payload: { error: "request_not_found", requested: id ?? null } };
}

/**
 * The public shape of a request. Derived fields (`nextLevel`, `remainingLevels`)
 * are computed here rather than stored, so they cannot drift out of step with
 * the approvals actually recorded.
 */
function viewOf(record) {
  const pending = record.status === "pending_approval";
  const next = pending ? LEVELS[record.approvals.length] : null;

  return {
    id: record.id,
    account: record.account,
    amount: record.amount,
    asset: "XLM",
    reference: record.reference,
    tier: record.tier,
    levelsRequired: record.levelsRequired,
    status: record.status,
    approvals: record.approvals.map((approval) => ({ ...approval })),
    approvalsRecorded: record.approvals.length,
    remainingLevels: pending ? record.levelsRequired - record.approvals.length : 0,
    nextLevel: next ? { level: next.level, name: next.name, approvers: [...next.approvers] } : null,
    rejection: record.rejection ? { ...record.rejection } : null,
    requestedAt: record.requestedAt,
    settledAt: record.settledAt,
  };
}

/**
 * `GET /policy` -- the tiers and the roster for each level.
 *
 * Readable on its own, so a caller can show "over 5000 needs two approvals"
 * without submitting a withdrawal to find out.
 */
export function getPolicy() {
  return {
    status: 200,
    payload: {
      asset: "XLM",
      tiers: TIERS.map((tier) => ({ ...tier })),
      levels: LEVELS.map((level) => ({ ...level, approvers: [...level.approvers] })),
      rule: "tier limits are inclusive; levels are cleared in order; one approver may not clear two levels of the same request",
    },
  };
}

/**
 * `POST /request` -- submit a withdrawal and get its approval chain.
 *
 * A zero-level request is already settled when it comes back; there is no
 * intermediate state for it to sit in.
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

  const tier = tierFor(stroops);
  const settledOnSubmission = tier.levelsRequired === 0;
  const now = new Date().toISOString();

  const record = {
    id: crypto.randomUUID(),
    account: account.trim(),
    amount: formatAmount(stroops),
    reference: reference ?? null,
    tier: tier.id,
    levelsRequired: tier.levelsRequired,
    status: settledOnSubmission ? "settled" : "pending_approval",
    approvals: [],
    rejection: null,
    requestedAt: now,
    settledAt: settledOnSubmission ? now : null,
  };

  requests.set(record.id, record);
  return { status: 201, payload: viewOf(record) };
}

/**
 * `GET /request?id=<requestId>` -- where a withdrawal is in its chain.
 */
export function getRequest(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest("id", "must be a non-empty request id");
  }
  const record = requests.get(id);
  if (!record) return notFound(id);
  return { status: 200, payload: viewOf(record) };
}

/**
 * Guards shared by `/approve` and `/reject`: a request must exist and still be
 * open before either can act on it.
 *
 * A settled zero-level request reports `no_approval_required` rather than the
 * generic "already closed" -- the caller asked for something the tier never
 * had, and that is worth saying plainly.
 */
function openRecordFor(id, approver) {
  if (typeof id !== "string" || id.trim() === "") {
    return { error: badRequest("id", "must be a non-empty request id") };
  }
  if (typeof approver !== "string" || approver.trim() === "") {
    return { error: badRequest("approver", "must be a non-empty string") };
  }

  const record = requests.get(id);
  if (!record) return { error: notFound(id) };

  if (record.status !== "pending_approval") {
    const noneNeeded = record.levelsRequired === 0;
    return {
      error: {
        status: 409,
        payload: {
          error: noneNeeded ? "no_approval_required" : "request_closed",
          id: record.id,
          status: record.status,
          tier: record.tier,
          levelsRequired: record.levelsRequired,
        },
      },
    };
  }

  return { record, approver: approver.trim() };
}

/**
 * `POST /approve` -- clear the next pending level.
 *
 * The caller does not say which level it is approving. The server takes the
 * next one in order, which removes any way to clear compliance before an
 * operator has signed off.
 */
export function approve({ id, approver } = {}) {
  const opened = openRecordFor(id, approver);
  if (opened.error) return opened.error;
  const { record, approver: who } = opened;

  const level = LEVELS[record.approvals.length];

  if (!level.approvers.includes(who)) {
    return {
      status: 403,
      payload: {
        error: "approver_not_authorised",
        id: record.id,
        approver: who,
        level: level.level,
        levelName: level.name,
        authorised: [...level.approvers],
      },
    };
  }

  // Separation of duties. `lead-erin` holds both roles, so this is a real check
  // and not a restatement of the roster membership above.
  const alreadyApproved = record.approvals.find((approval) => approval.approver === who);
  if (alreadyApproved) {
    return {
      status: 403,
      payload: {
        error: "separation_of_duties",
        id: record.id,
        approver: who,
        alreadyApprovedLevel: alreadyApproved.level,
        attemptedLevel: level.level,
      },
    };
  }

  record.approvals.push({
    level: level.level,
    levelName: level.name,
    approver: who,
    approvedAt: new Date().toISOString(),
  });

  const complete = record.approvals.length === record.levelsRequired;
  if (complete) {
    record.status = "settled";
    record.settledAt = new Date().toISOString();
  }

  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /reject` -- close the request at whatever level it has reached.
 *
 * Any approver authorised for the level currently pending may reject. A
 * rejection ends the chain; the approvals already recorded are kept, so the
 * record still shows how far it got.
 */
export function reject({ id, approver, reason } = {}) {
  const opened = openRecordFor(id, approver);
  if (opened.error) return opened.error;
  const { record, approver: who } = opened;

  if (reason !== undefined && typeof reason !== "string") {
    return badRequest("reason", "must be a string when provided");
  }

  const level = LEVELS[record.approvals.length];
  if (!level.approvers.includes(who)) {
    return {
      status: 403,
      payload: {
        error: "approver_not_authorised",
        id: record.id,
        approver: who,
        level: level.level,
        levelName: level.name,
        authorised: [...level.approvers],
      },
    };
  }

  record.status = "rejected";
  record.rejection = {
    approver: who,
    level: level.level,
    levelName: level.name,
    reason: reason ?? null,
    rejectedAt: new Date().toISOString(),
  };

  return { status: 200, payload: viewOf(record) };
}

export function handleRequest(method, pathname, body, query) {
  if (method === "GET" && pathname === "/policy") return getPolicy();
  if (method === "GET" && pathname === "/request") return getRequest(query?.id);
  if (method === "POST" && pathname === "/request") return requestWithdrawal(body ?? {});
  if (method === "POST" && pathname === "/approve") return approve(body ?? {});
  if (method === "POST" && pathname === "/reject") return reject(body ?? {});
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4148;
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
    console.log(`withdrawal-chain-suite mock listening on http://localhost:${PORT}/policy`);
  });
}
