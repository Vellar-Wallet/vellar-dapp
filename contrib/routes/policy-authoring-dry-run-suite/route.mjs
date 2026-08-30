import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Policy Authoring, Validation, and Dry Run (Issue #92)
 *
 * A policy moves through three stages before it could ever be deployed:
 *
 *   1. Author a draft (`POST /policies`) -- stored, but inert.
 *   2. Validate it (`POST /policies/:id/validate`) -- checks field shapes and
 *      rule semantics without touching any transaction. A draft with errors
 *      cannot move on.
 *   3. Dry run it (`POST /policies/:id/dry-run`) -- only once validation has
 *      passed -- against sample transactions, or a caller-supplied set, and
 *      reports what would pass and what would fail. Nothing is deployed by
 *      any of this; there is no endpoint that makes a policy live.
 *
 * Everything is in memory; no chain or database is touched.
 */

const RULES = {
  maxAmount(limit, tx) {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) {
      return [`amount ${JSON.stringify(tx.amount ?? null)} is not a number`];
    }
    return amount > limit ? [`amount ${amount} exceeds maxAmount ${limit}`] : [];
  },
  allowedAssets(assets, tx) {
    return assets.includes(tx.asset)
      ? []
      : [`asset ${JSON.stringify(tx.asset ?? null)} is not on the allowed list`];
  },
  allowedRecipients(recipients, tx) {
    return recipients.includes(tx.recipient)
      ? []
      : [`recipient ${JSON.stringify(tx.recipient ?? null)} is not on the allowed list`];
  },
  requireMemo(required, tx) {
    if (required !== true) return [];
    const memo = tx.memo;
    return typeof memo === "string" && memo.trim() !== "" ? [] : ["memo is required but missing"];
  },
};

const SUPPORTED_RULES = Object.keys(RULES);

/**
 * Per-rule shape checks, run at validation time rather than dry-run time, so
 * a caller finds out a rule is malformed before it is ever evaluated against
 * a transaction -- a `maxAmount` of `"a lot"` should not silently match
 * nothing.
 */
const FIELD_CHECKS = {
  maxAmount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return "must be a positive finite number";
    }
    return null;
  },
  allowedAssets(value) {
    if (!Array.isArray(value) || value.length === 0) {
      return "must be a non-empty array of asset codes";
    }
    if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
      return "every entry must be a non-empty string";
    }
    return null;
  },
  allowedRecipients(value) {
    if (!Array.isArray(value) || value.length === 0) {
      return "must be a non-empty array of recipient addresses";
    }
    if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
      return "every entry must be a non-empty string";
    }
    return null;
  },
  requireMemo(value) {
    return typeof value === "boolean" ? null : "must be a boolean";
  },
};

export const SAMPLE_TRANSACTIONS = [
  {
    id: "tx_01",
    amount: "50.0000000",
    asset: "XLM",
    recipient: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    memo: "invoice-2201",
  },
  {
    id: "tx_02",
    amount: "1200.0000000",
    asset: "USDC",
    recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    memo: "hardware batch",
  },
  {
    id: "tx_03",
    amount: "8.5000000",
    asset: "XLM",
    recipient: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    memo: "",
  },
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** id -> record */
const policies = new Map();

/** Clears every stored policy. Exported for tests. */
export function resetState() {
  policies.clear();
}

function badRequest(payload) {
  return { status: 400, payload: { error: "invalid_request", ...payload } };
}

function notFound(id) {
  return { status: 404, payload: { error: "policy_not_found", requested: id ?? null } };
}

function viewOf(record) {
  return {
    id: record.id,
    name: record.name,
    rules: { ...record.rules },
    status: record.status,
    validation: record.validation
      ? { valid: record.validation.valid, errors: [...record.validation.errors] }
      : null,
    lastDryRun: record.lastDryRun ? { ...record.lastDryRun } : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * `POST /policies` -- author a draft. Only the shape of the request itself is
 * checked (`name`, `rules` present and typed); rule semantics are the
 * validate step's job, not this one's, so an author can save a draft with
 * rules they are still tuning.
 */
export function createPolicy({ name, rules } = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    return badRequest({ field: "name", reason: "must be a non-empty string" });
  }
  if (!isPlainObject(rules) || Object.keys(rules).length === 0) {
    return badRequest({ field: "rules", reason: "must be a non-empty object" });
  }

  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    name: name.trim(),
    rules: { ...rules },
    status: "draft",
    validation: null,
    lastDryRun: null,
    createdAt: now,
    updatedAt: now,
  };
  policies.set(record.id, record);
  return { status: 201, payload: viewOf(record) };
}

/** `GET /policies/:id` -- read back a policy's current stage and result. */
export function getPolicy(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest({ field: "id", reason: "must be a non-empty policy id" });
  }
  const record = policies.get(id);
  if (!record) return notFound(id);
  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /policies/:id/validate` -- checks every rule name is supported and
 * every rule's value has the right shape. Recorded on the policy so a dry
 * run can refuse to proceed on a policy that has never passed -- or last
 * failed -- validation.
 *
 * Re-validating is always allowed, including after a policy has already
 * passed, so an author who edits rules in place (there is no separate PATCH)
 * can re-check before dry-running again.
 */
export function validatePolicy(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest({ field: "id", reason: "must be a non-empty policy id" });
  }
  const record = policies.get(id);
  if (!record) return notFound(id);

  const errors = [];
  for (const [rule, value] of Object.entries(record.rules)) {
    if (!SUPPORTED_RULES.includes(rule)) {
      errors.push({ rule, reason: `unsupported rule; supported: ${SUPPORTED_RULES.join(", ")}` });
      continue;
    }
    const problem = FIELD_CHECKS[rule](value);
    if (problem) errors.push({ rule, reason: problem });
  }

  const valid = errors.length === 0;
  record.validation = { valid, errors };
  record.status = valid ? "validated" : "invalid";
  record.updatedAt = new Date().toISOString();

  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /policies/:id/dry-run` -- simulate the policy against transactions.
 *
 * Gated on validation: a policy that has never been validated, or whose last
 * validation failed, is refused with `409 not_validated` rather than run
 * anyway. Running an unvalidated policy would report a clean pass for rules
 * that are silently broken -- the same failure mode the dry run itself
 * exists to catch, just one step earlier.
 */
export function dryRunPolicy(id, { transactions } = {}) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest({ field: "id", reason: "must be a non-empty policy id" });
  }
  const record = policies.get(id);
  if (!record) return notFound(id);

  if (!record.validation || !record.validation.valid) {
    return {
      status: 409,
      payload: {
        error: "not_validated",
        id: record.id,
        status: record.status,
        reason: record.validation
          ? "the last validation failed"
          : "this policy has never been validated",
      },
    };
  }

  const txs = transactions === undefined ? SAMPLE_TRANSACTIONS : transactions;
  if (!Array.isArray(txs)) {
    return badRequest({ field: "transactions", reason: "must be an array when provided" });
  }
  const nonObject = txs.findIndex((tx) => !isPlainObject(tx));
  if (nonObject !== -1) {
    return badRequest({ field: `transactions[${nonObject}]`, reason: "must be an object" });
  }

  const results = txs.map((tx, index) => {
    const violations = [];
    for (const [rule, config] of Object.entries(record.rules)) {
      for (const reason of RULES[rule](config, tx)) {
        violations.push({ rule, reason });
      }
    }
    return {
      index,
      id: typeof tx.id === "string" ? tx.id : null,
      decision: violations.length === 0 ? "pass" : "fail",
      violations,
    };
  });

  const failed = results.filter((result) => result.decision === "fail").length;
  const summary = { simulated: results.length, passed: results.length - failed, failed };

  record.lastDryRun = {
    // Explicit, so a caller can never mistake a dry run for a deploy -- there
    // is no endpoint in this suite that makes a policy live.
    persisted: false,
    ranAt: new Date().toISOString(),
    summary,
    results,
  };
  record.updatedAt = record.lastDryRun.ranAt;

  return { status: 200, payload: { persisted: false, summary, results } };
}

export function handleRequest(method, pathname, body, _query) {
  if (method === "POST" && pathname === "/policies") return createPolicy(body ?? {});

  const validateMatch = pathname.match(/^\/policies\/([^/]+)\/validate$/);
  if (method === "POST" && validateMatch)
    return validatePolicy(decodeURIComponent(validateMatch[1]));

  const dryRunMatch = pathname.match(/^\/policies\/([^/]+)\/dry-run$/);
  if (method === "POST" && dryRunMatch) {
    return dryRunPolicy(decodeURIComponent(dryRunMatch[1]), body ?? {});
  }

  const getMatch = pathname.match(/^\/policies\/([^/]+)$/);
  if (method === "GET" && getMatch) return getPolicy(decodeURIComponent(getMatch[1]));

  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4092;
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
      const { status, payload } = handleRequest(req.method, url.pathname, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(PORT, () => {
    console.log(
      `policy-authoring-dry-run-suite mock listening on http://localhost:${PORT}/policies`,
    );
  });
}
