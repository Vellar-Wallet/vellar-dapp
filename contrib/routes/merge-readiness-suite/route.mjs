import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Multi Step Account Merge Readiness (Issue #95)
 *
 * Walks a sample account through three stages: inspection, blocker resolution,
 * and a final merge readiness confirmation.
 *
 * The confirmation is the point of the suite. `/confirm` issues a record only
 * when every blocker found at inspection has been resolved; while any remain it
 * refuses with 409 and names them. A confirmation is also pinned to the exact
 * set of blockers it was issued against, so it cannot be quietly reused as
 * evidence for a different state of the account.
 *
 * Sample accounts and their blockers live in SAMPLE_ACCOUNTS below; that table
 * is the whole data source.
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const SAMPLE_ACCOUNTS = {
  GA_BLOCKED: {
    profile: {
      account: "GA_BLOCKED",
      balance: "1250.5000000",
      trustlines: 3,
      signers: 2,
      openOffers: 1,
      flags: 1,
    },
    blockers: [
      {
        id: "open-offers",
        severity: "medium",
        message: "1 open offer must be cancelled before the account can be merged",
      },
      {
        id: "extra-signers",
        severity: "high",
        message: "2 signers present; a merge requires the master key alone",
      },
      {
        id: "account-flags",
        severity: "low",
        message: "Auth flags are set and must be cleared",
      },
      {
        id: "open-trustlines",
        severity: "high",
        message: "3 trustlines still hold reserves and must be closed",
      },
    ],
  },
  GA_ONE_BLOCKER: {
    profile: {
      account: "GA_ONE_BLOCKER",
      balance: "80.0000000",
      trustlines: 1,
      signers: 1,
      openOffers: 0,
      flags: 0,
    },
    blockers: [
      {
        id: "open-trustlines",
        severity: "high",
        message: "1 trustline still holds a reserve and must be closed",
      },
    ],
  },
  GA_READY: {
    profile: {
      account: "GA_READY",
      balance: "12.0000000",
      trustlines: 0,
      signers: 1,
      openOffers: 0,
      flags: 0,
    },
    blockers: [],
  },
};

/** accountId -> { resolved: Set<blockerId>, confirmation } */
const progress = new Map();

/** Clears all resolution progress and confirmations. Exported for tests. */
export function resetState() {
  progress.clear();
}

function stateFor(accountId) {
  let state = progress.get(accountId);
  if (!state) {
    state = { resolved: new Set(), confirmation: null };
    progress.set(accountId, state);
  }
  return state;
}

function notFound(accountId) {
  return {
    status: 404,
    payload: {
      error: "account_not_found",
      requested: accountId ?? null,
      knownAccounts: Object.keys(SAMPLE_ACCOUNTS),
    },
  };
}

/** Blockers sorted high -> medium -> low, each tagged with its resolved state. */
function blockersFor(accountId, state) {
  return SAMPLE_ACCOUNTS[accountId].blockers
    .map((blocker) => ({ ...blocker, resolved: state.resolved.has(blocker.id) }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function readinessFor(accountId, state) {
  const blockers = blockersFor(accountId, state);
  const outstanding = blockers.filter((blocker) => !blocker.resolved);
  return {
    account: accountId,
    ready: outstanding.length === 0,
    outstanding: outstanding.map((blocker) => blocker.id),
    resolved: blockers.filter((blocker) => blocker.resolved).map((blocker) => blocker.id),
    totalBlockers: blockers.length,
  };
}

/**
 * Stage 1 — `GET /inspect?account=<id>`.
 * The account profile plus its blockers, worst severity first.
 */
export function inspect(accountId) {
  if (!Object.hasOwn(SAMPLE_ACCOUNTS, accountId ?? "")) return notFound(accountId);
  const state = stateFor(accountId);
  const blockers = blockersFor(accountId, state);

  return {
    status: 200,
    payload: {
      account: SAMPLE_ACCOUNTS[accountId].profile,
      blockers,
      blockerCount: blockers.length,
      outstandingCount: blockers.filter((blocker) => !blocker.resolved).length,
    },
  };
}

/**
 * Stage 2 — `POST /resolve`.
 * Marks one blocker resolved. Resolution is idempotent: re-resolving reports
 * `alreadyResolved` rather than failing, since the end state is the same.
 */
export function resolveBlocker({ account: accountId, blocker: blockerId } = {}) {
  if (!Object.hasOwn(SAMPLE_ACCOUNTS, accountId ?? "")) return notFound(accountId);

  const known = SAMPLE_ACCOUNTS[accountId].blockers.find((entry) => entry.id === blockerId);
  if (!known) {
    return {
      status: 404,
      payload: {
        error: "blocker_not_found",
        account: accountId,
        requested: blockerId ?? null,
        accountBlockers: SAMPLE_ACCOUNTS[accountId].blockers.map((entry) => entry.id),
      },
    };
  }

  const state = stateFor(accountId);
  const alreadyResolved = state.resolved.has(blockerId);
  state.resolved.add(blockerId);

  // `blocker`, not `resolved`: the readiness payload spread in below already
  // uses `resolved` for the full list of cleared blocker ids.
  return {
    status: 200,
    payload: {
      blocker: blockerId,
      severity: known.severity,
      alreadyResolved,
      ...readinessFor(accountId, state),
    },
  };
}

/**
 * Stage 3a — `GET /readiness?account=<id>`.
 * Whether the account is ready, and what is still in the way if not.
 */
export function getReadiness(accountId) {
  if (!Object.hasOwn(SAMPLE_ACCOUNTS, accountId ?? "")) return notFound(accountId);
  const state = stateFor(accountId);

  return {
    status: 200,
    payload: {
      ...readinessFor(accountId, state),
      confirmed: state.confirmation !== null,
      confirmationId: state.confirmation ? state.confirmation.confirmationId : null,
    },
  };
}

/**
 * Stage 3b — `POST /confirm`.
 * Issues the merge readiness confirmation, but only once every blocker is
 * resolved. The record pins the blocker set it was issued against so it cannot
 * be reused as evidence for a different state of the account.
 */
export function confirmReadiness({ account: accountId } = {}) {
  if (!Object.hasOwn(SAMPLE_ACCOUNTS, accountId ?? "")) return notFound(accountId);

  const state = stateFor(accountId);
  const readiness = readinessFor(accountId, state);

  if (!readiness.ready) {
    return {
      status: 409,
      payload: { error: "not_ready", ...readiness },
    };
  }

  // Re-confirming returns the original record rather than minting a second one.
  if (state.confirmation) {
    return { status: 200, payload: { ...state.confirmation, alreadyConfirmed: true } };
  }

  state.confirmation = {
    account: accountId,
    ready: true,
    confirmationId: crypto.randomUUID(),
    confirmedAt: new Date().toISOString(),
    resolvedBlockers: readiness.resolved,
    totalBlockers: readiness.totalBlockers,
  };

  return { status: 201, payload: { ...state.confirmation, alreadyConfirmed: false } };
}

export function handleRequest(method, pathname, body, query) {
  if (method === "GET" && pathname === "/inspect") return inspect(query?.account);
  if (method === "GET" && pathname === "/readiness") return getReadiness(query?.account);
  if (method === "POST" && pathname === "/resolve") return resolveBlocker(body ?? {});
  if (method === "POST" && pathname === "/confirm") return confirmReadiness(body ?? {});
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4095;
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
    console.log(`merge-readiness-suite mock listening on http://localhost:${PORT}/inspect`);
  });
}
