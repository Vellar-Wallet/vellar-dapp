// Mock POST route simulating a proposed policy against a set of sample
// transactions. Nothing is persisted and no chain or DB is touched: the
// response is the whole result.
import http from "node:http";
import { pathToFileURL } from "node:url";

// Each rule reports the violations it finds on one transaction. Rule names
// follow the parameter vocabulary used by the policy templates route.
const RULES = {
  maxAmount(limit, tx) {
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) {
      return [`amount ${JSON.stringify(tx.amount ?? null)} is not a number`];
    }
    const max = Number(limit);
    if (!Number.isFinite(max)) return [];
    return amount > max ? [`amount ${amount} exceeds maxAmount ${max}`] : [];
  },

  allowedAssets(assets, tx) {
    if (!Array.isArray(assets)) return [];
    if (assets.includes(tx.asset)) return [];
    return [`asset ${JSON.stringify(tx.asset ?? null)} is not on the allowed list`];
  },

  allowedRecipients(recipients, tx) {
    if (!Array.isArray(recipients)) return [];
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

// Used when the caller sends a policy but no transactions, so a policy can be
// tried against a known set without assembling one first.
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
  {
    id: "tx_04",
    amount: "310.0000000",
    asset: "EURC",
    recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ",
    memo: "contractor payout",
  },
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evaluate(policy, tx, index) {
  const violations = [];
  for (const [rule, config] of Object.entries(policy)) {
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
}

export function handleRequest({ body = {} } = {}) {
  const { policy } = body;
  // Omitting transactions falls back to the built-in sample set; sending
  // something that is not a list is a mistake, not a request for the default.
  const transactions = body.transactions === undefined ? SAMPLE_TRANSACTIONS : body.transactions;

  if (!isPlainObject(policy)) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "policy must be an object" },
    };
  }
  if (!Array.isArray(transactions)) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "transactions must be an array" },
    };
  }

  // A misspelled rule would otherwise be ignored, and the dry run would report
  // a clean pass for a policy that does not do what the caller wrote. For a
  // tool whose only job is to tell you what a policy would do, that is the
  // worst possible failure mode, so reject it up front.
  const unsupported = Object.keys(policy).filter((rule) => !SUPPORTED_RULES.includes(rule));
  if (unsupported.length > 0) {
    return {
      status: 400,
      body: {
        error: "unsupported_rule",
        message: `Unsupported policy rule(s): ${unsupported.join(", ")}`,
        unsupportedRules: unsupported,
        supportedRules: SUPPORTED_RULES,
      },
    };
  }

  const nonObject = transactions.findIndex((tx) => !isPlainObject(tx));
  if (nonObject !== -1) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: `transactions[${nonObject}] must be an object`,
      },
    };
  }

  const results = transactions.map((tx, index) => evaluate(policy, tx, index));
  const failed = results.filter((result) => result.decision === "fail").length;

  return {
    status: 200,
    body: {
      // Stated explicitly so a caller can never mistake a dry run for a commit.
      persisted: false,
      summary: {
        simulated: results.length,
        passed: results.length - failed,
        failed,
      },
      results,
    },
  };
}

// pathToFileURL rather than a `file://` template: on Windows argv[1] is a
// drive path, which does not compare equal to import.meta.url otherwise.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/policy/dry-run") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "invalid_json", message: "Request body must be valid JSON" }),
          );
          return;
        }
        const { status, body: responseBody } = handleRequest({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4072;
  server.listen(port, () => {
    console.log(`policy-dry-run mock listening on http://localhost:${port}/policy/dry-run`);
  });
}
