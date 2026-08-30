// Mock route simulating off-chain evaluation of a proposed transaction
// against the safety policy contract's rules, so a rejection can be
// explained to the user before the passkey prompt instead of surfacing as an
// unexplained on-chain failure.
//
// Divergence prevention: the classification and rule logic below is a direct
// mirror of contrib/contracts/safety-policy/src/lib.rs
// (parse_authorization_context + Contract::policy__). It intentionally does
// not add rules or leniency the contract does not have. If that contract
// changes, this file must change in the same PR -- there is no automated
// link between them (this is a JS mock in contrib/, not a binding to the
// real wasm), so keeping them in sync is a manual, reviewed step. A change
// here without a matching contract change (or vice versa) should fail
// review.
//
// Wiring note: actually surfacing this in the transaction review step (the
// UI screen shown before the passkey prompt) requires touching apps/, which
// is outside contrib/'s scope for external contributors. This suite provides
// the reusable `evaluateTransactionSafety` function that step is meant to
// call; wiring it in is left to a maintainer per CONTRIBUTING.md.
import http from "node:http";
import { pathToFileURL } from "node:url";

/**
 * Classifies one authorization context, mirroring
 * `parse_authorization_context` in the Rust contract:
 * - a `transfer` call with a valid `to` address and a positive amount is a
 *   TokenTransfer
 * - any other contract call is an OtherContractCall
 * - anything malformed or non-contract is Unknown
 *
 * Input shape mirrors a Soroban `Context::Contract`: { contract, fnName, args }
 * where `args` is positional, args[1] = to, args[2] = amount for `transfer`.
 */
export function classifyContext(ctx) {
  if (
    ctx === null ||
    typeof ctx !== "object" ||
    typeof ctx.contract !== "string" ||
    ctx.contract.trim() === "" ||
    typeof ctx.fnName !== "string" ||
    ctx.fnName.trim() === ""
  ) {
    return { type: "unknown" };
  }

  if (ctx.fnName !== "transfer") {
    return { type: "other_call", contract: ctx.contract, fnName: ctx.fnName };
  }

  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const to = args[1];
  const rawAmount = args[2];

  if (typeof to !== "string" || to.trim() === "") {
    return { type: "unknown" };
  }

  const amount = typeof rawAmount === "string" ? Number(rawAmount) : rawAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { type: "unknown" };
  }

  return { type: "transfer", contract: ctx.contract, to, amount };
}

/**
 * Evaluates one classified interaction against the config, mirroring
 * `Contract::policy__`'s per-interaction match arm.
 */
function evaluateInteraction(config, interaction) {
  switch (interaction.type) {
    case "transfer":
      if (interaction.amount > config.maxTransferAmount) {
        return {
          decision: "rejected",
          rule: "max-transfer-amount",
          reason: `amount ${interaction.amount} exceeds maxTransferAmount ${config.maxTransferAmount}`,
        };
      }
      return { decision: "allowed" };

    case "other_call":
      return {
        decision: "rejected",
        rule: "non-transfer-call",
        reason: `calls '${interaction.fnName}' on ${interaction.contract}, but the policy only allows token transfers`,
      };

    case "unknown":
    default:
      // Honest, not permissive: an unclassifiable interaction is reported as
      // such, not folded into a generic rule or treated as safe. The
      // contract itself denies unknown interactions by default.
      return {
        decision: "rejected",
        rule: "unknown-interaction",
        reason:
          "this interaction could not be classified as a token transfer or a plain contract call; " +
          "the contract denies unclassifiable interactions by default",
      };
  }
}

/**
 * Evaluates a full list of authorization contexts, mirroring the contract's
 * `policy__`: an empty context list is rejected outright, and the contract
 * panics (stops) on the first rejecting interaction rather than continuing
 * to evaluate the rest. This mirrors that short-circuit exactly so the
 * reported reason matches what the contract would actually act on.
 */
export function evaluateTransactionSafety(config, contexts) {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return {
      verdict: "rejected",
      rule: "no-interactions",
      reason: "no interactions to evaluate; the contract rejects an empty context list",
      interactions: [],
    };
  }

  const interactions = [];
  let firstRejection = null;

  for (const ctx of contexts) {
    const classified = classifyContext(ctx);
    const outcome = evaluateInteraction(config, classified);
    interactions.push({ classification: classified.type, ...outcome });
    if (outcome.decision === "rejected" && firstRejection === null) {
      firstRejection = outcome;
    }
  }

  if (firstRejection === null) {
    return { verdict: "allowed", interactions };
  }

  return {
    verdict: "rejected",
    rule: firstRejection.rule,
    reason: firstRejection.reason,
    interactions,
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function handleRequest({ body = {} } = {}) {
  const { config, contexts } = body;

  if (
    !isPlainObject(config) ||
    typeof config.maxTransferAmount !== "number" ||
    config.maxTransferAmount <= 0
  ) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "config.maxTransferAmount must be a positive number",
      },
    };
  }
  if (contexts !== undefined && !Array.isArray(contexts)) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "contexts must be an array" },
    };
  }

  const result = evaluateTransactionSafety(config, contexts ?? []);
  return { status: 200, body: result };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/policy/simulate-rejection") {
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
  const port = process.env.PORT || 4023;
  server.listen(port, () => {
    console.log(
      `tx-rejection-explainer mock listening on http://localhost:${port}/policy/simulate-rejection`,
    );
  });
}
