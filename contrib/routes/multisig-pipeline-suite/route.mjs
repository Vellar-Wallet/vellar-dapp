import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Multisig Proposal To Execution Pipeline (Issue #150)
 *
 * Propose a transaction against a multisig wallet, collect signer votes, and
 * execute it once the approving weight reaches the wallet threshold.
 *
 * Signers carry weights rather than a flat one-vote-each count, so "three of
 * four signed" is not the same question as "did we reach the threshold". The
 * two interesting consequences:
 *
 *   - Proposing is signing. A signer cannot propose a transaction they are not
 *     willing to sign, so the proposer's weight counts from the moment the
 *     proposal exists -- and on a wallet whose threshold their weight alone
 *     meets, the proposal is executable immediately.
 *   - A proposal can die before every signer has voted. Once the approving
 *     weight plus the weight still undecided cannot reach the threshold, the
 *     outcome is already decided and the proposal is rejected rather than left
 *     open for votes that cannot change it.
 *
 * Votes are final, which is what makes both of those states monotonic: a
 * proposal that has reached the threshold cannot fall back below it, and one
 * that has become unreachable cannot be revived. Execution latches once -- the
 * classic multisig failure is executing the same approved proposal twice.
 *
 * Everything is in memory; nothing is signed or submitted.
 */

/**
 * Sample wallets. Weights are per signer; `threshold` is the total approving
 * weight required, not a signer count.
 */
const WALLETS = {
  GW_TEAM: {
    id: "GW_TEAM",
    threshold: 3,
    signers: [
      { id: "alice", weight: 2 },
      { id: "bob", weight: 1 },
      { id: "carol", weight: 1 },
      { id: "dave", weight: 1 },
    ],
  },
  // Threshold equals the only signer's weight: proposing alone clears it.
  GW_SOLO: {
    id: "GW_SOLO",
    threshold: 1,
    signers: [{ id: "solo", weight: 1 }],
  },
  // Threshold equals total weight: unanimous, so a single reject kills it.
  GW_UNANIMOUS: {
    id: "GW_UNANIMOUS",
    threshold: 4,
    signers: [
      { id: "erin", weight: 1 },
      { id: "frank", weight: 1 },
      { id: "grace", weight: 1 },
      { id: "heidi", weight: 1 },
    ],
  },
};

const VOTES = ["approve", "reject"];

/** proposalId -> record */
const proposals = new Map();

/** Clears every stored proposal. Exported for tests. */
export function resetState() {
  proposals.clear();
}

function badRequest(field, reason, extra = {}) {
  return { status: 400, payload: { error: "invalid_request", field, reason, ...extra } };
}

function walletNotFound(id) {
  return {
    status: 404,
    payload: {
      error: "wallet_not_found",
      requested: id ?? null,
      knownWallets: Object.keys(WALLETS),
    },
  };
}

function signerFor(wallet, signerId) {
  return wallet.signers.find((signer) => signer.id === signerId);
}

function totalWeight(wallet) {
  return wallet.signers.reduce((sum, signer) => sum + signer.weight, 0);
}

/**
 * The current tally, recomputed from the votes recorded rather than stored.
 *
 * `maxAttainable` is the whole point: approving weight plus everything still
 * undecided. Once that falls below the threshold the proposal cannot pass, no
 * matter who is yet to vote.
 */
function tallyOf(record) {
  const wallet = WALLETS[record.wallet];
  let approvedWeight = 0;
  let rejectedWeight = 0;

  for (const vote of record.votes) {
    const weight = signerFor(wallet, vote.signer).weight;
    if (vote.vote === "approve") approvedWeight += weight;
    else rejectedWeight += weight;
  }

  const undecidedWeight = totalWeight(wallet) - approvedWeight - rejectedWeight;

  return {
    threshold: wallet.threshold,
    totalWeight: totalWeight(wallet),
    approvedWeight,
    rejectedWeight,
    undecidedWeight,
    maxAttainable: approvedWeight + undecidedWeight,
  };
}

/**
 * The outcome implied by the tally.
 *
 * Both terminal states are monotonic because votes are final: weight already
 * approved cannot be withdrawn, and weight already rejected cannot be
 * reclaimed.
 */
function outcomeOf(tally) {
  if (tally.approvedWeight >= tally.threshold) return "ready";
  if (tally.maxAttainable < tally.threshold) return "rejected";
  return "pending";
}

/** The public shape of a proposal, with the tally and outcome derived fresh. */
function viewOf(record) {
  const wallet = WALLETS[record.wallet];
  const tally = tallyOf(record);
  const status = record.execution ? "executed" : outcomeOf(tally);
  const voted = new Set(record.votes.map((vote) => vote.signer));

  return {
    id: record.id,
    wallet: record.wallet,
    proposer: record.proposer,
    operation: record.operation,
    status,
    ...tally,
    votes: record.votes.map((vote) => ({ ...vote })),
    awaiting: wallet.signers.filter((signer) => !voted.has(signer.id)).map((signer) => signer.id),
    readyToExecute: status === "ready",
    execution: record.execution ? { ...record.execution } : null,
    proposedAt: record.proposedAt,
  };
}

/**
 * `GET /wallet?id=<walletId>` -- signers, weights and threshold.
 */
export function getWallet(id) {
  if (!Object.hasOwn(WALLETS, id ?? "")) return walletNotFound(id);
  const wallet = WALLETS[id];
  return {
    status: 200,
    payload: {
      id: wallet.id,
      threshold: wallet.threshold,
      totalWeight: totalWeight(wallet),
      signers: wallet.signers.map((signer) => ({ ...signer })),
    },
  };
}

/**
 * `POST /propose` -- open a proposal.
 *
 * The proposer must be a signer, and their approval is recorded with the
 * proposal: proposing is signing. On `GW_SOLO`, whose threshold one signer's
 * weight already meets, the proposal comes back `ready` with no further votes.
 */
export function propose({ wallet: walletId, proposer, operation } = {}) {
  if (!Object.hasOwn(WALLETS, walletId ?? "")) return walletNotFound(walletId);

  const wallet = WALLETS[walletId];
  if (typeof proposer !== "string" || proposer.trim() === "") {
    return badRequest("proposer", "must be a non-empty signer id");
  }
  if (typeof operation !== "string" || operation.trim() === "") {
    return badRequest("operation", "must be a non-empty description of the transaction");
  }

  const signer = signerFor(wallet, proposer.trim());
  if (!signer) {
    return {
      status: 403,
      payload: {
        error: "not_a_signer",
        wallet: walletId,
        signer: proposer.trim(),
        signers: wallet.signers.map((entry) => entry.id),
      },
    };
  }

  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    wallet: walletId,
    proposer: signer.id,
    operation: operation.trim(),
    votes: [{ signer: signer.id, weight: signer.weight, vote: "approve", votedAt: now }],
    execution: null,
    proposedAt: now,
  };

  proposals.set(record.id, record);
  return { status: 201, payload: viewOf(record) };
}

/**
 * `GET /proposal?id=<proposalId>` -- the proposal with its live tally.
 */
export function getProposal(id) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest("id", "must be a non-empty proposal id");
  }
  const record = proposals.get(id);
  if (!record) {
    return { status: 404, payload: { error: "proposal_not_found", requested: id } };
  }
  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /vote` -- record one signer's vote.
 *
 * Votes are final. A signer who has already voted is refused rather than having
 * their vote overwritten, because a proposal that has reached its threshold
 * must not be able to fall back below it.
 */
export function vote({ id, signer: signerId, vote: choice } = {}) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest("id", "must be a non-empty proposal id");
  }
  if (typeof signerId !== "string" || signerId.trim() === "") {
    return badRequest("signer", "must be a non-empty signer id");
  }
  if (!VOTES.includes(choice)) {
    return badRequest("vote", `must be one of ${VOTES.join(", ")}`, {
      received: choice === undefined ? null : String(choice),
    });
  }

  const record = proposals.get(id);
  if (!record) {
    return { status: 404, payload: { error: "proposal_not_found", requested: id } };
  }

  const wallet = WALLETS[record.wallet];
  const signer = signerFor(wallet, signerId.trim());
  if (!signer) {
    return {
      status: 403,
      payload: {
        error: "not_a_signer",
        wallet: record.wallet,
        signer: signerId.trim(),
        signers: wallet.signers.map((entry) => entry.id),
      },
    };
  }

  // Closed before duplicate: on a settled proposal the vote is moot either way,
  // and "this is closed" is the more useful thing to hear.
  const status = record.execution ? "executed" : outcomeOf(tallyOf(record));
  if (status !== "pending") {
    return {
      status: 409,
      payload: { error: "voting_closed", id: record.id, status, ...tallyOf(record) },
    };
  }

  const existing = record.votes.find((entry) => entry.signer === signer.id);
  if (existing) {
    return {
      status: 409,
      payload: {
        error: "already_voted",
        id: record.id,
        signer: signer.id,
        recordedVote: existing.vote,
        // The proposer's approval was recorded when they opened the proposal.
        viaProposal: signer.id === record.proposer,
      },
    };
  }

  record.votes.push({
    signer: signer.id,
    weight: signer.weight,
    vote: choice,
    votedAt: new Date().toISOString(),
  });

  return { status: 200, payload: viewOf(record) };
}

/**
 * `POST /execute` -- execute a proposal that has reached its threshold.
 *
 * The execution record pins the tally it was executed against, so it cannot be
 * read as evidence for some other set of votes. Re-executing returns the
 * original record rather than running a second time.
 */
export function execute({ id, executor } = {}) {
  if (typeof id !== "string" || id.trim() === "") {
    return badRequest("id", "must be a non-empty proposal id");
  }
  if (typeof executor !== "string" || executor.trim() === "") {
    return badRequest("executor", "must be a non-empty signer id");
  }

  const record = proposals.get(id);
  if (!record) {
    return { status: 404, payload: { error: "proposal_not_found", requested: id } };
  }

  const wallet = WALLETS[record.wallet];
  if (!signerFor(wallet, executor.trim())) {
    return {
      status: 403,
      payload: {
        error: "not_a_signer",
        wallet: record.wallet,
        signer: executor.trim(),
        signers: wallet.signers.map((entry) => entry.id),
      },
    };
  }

  // Idempotent: the same approved proposal must never execute twice.
  if (record.execution) {
    return {
      status: 200,
      payload: { ...viewOf(record), alreadyExecuted: true },
    };
  }

  const tally = tallyOf(record);
  const outcome = outcomeOf(tally);
  if (outcome !== "ready") {
    return {
      status: 409,
      payload: {
        error: outcome === "rejected" ? "proposal_rejected" : "threshold_not_reached",
        id: record.id,
        status: outcome,
        ...tally,
        awaiting: viewOf(record).awaiting,
      },
    };
  }

  record.execution = {
    txHash: crypto.randomUUID().replace(/-/g, ""),
    executedBy: executor.trim(),
    executedAt: new Date().toISOString(),
    approvedWeight: tally.approvedWeight,
    threshold: tally.threshold,
    approvedBy: record.votes
      .filter((entry) => entry.vote === "approve")
      .map((entry) => entry.signer),
  };

  return { status: 200, payload: { ...viewOf(record), alreadyExecuted: false } };
}

export function handleRequest(method, pathname, body, query) {
  if (method === "GET" && pathname === "/wallet") return getWallet(query?.id);
  if (method === "GET" && pathname === "/proposal") return getProposal(query?.id);
  if (method === "POST" && pathname === "/propose") return propose(body ?? {});
  if (method === "POST" && pathname === "/vote") return vote(body ?? {});
  if (method === "POST" && pathname === "/execute") return execute(body ?? {});
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4150;
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
    console.log(
      `multisig-pipeline-suite mock listening on http://localhost:${PORT}/wallet?id=GW_TEAM`,
    );
  });
}
