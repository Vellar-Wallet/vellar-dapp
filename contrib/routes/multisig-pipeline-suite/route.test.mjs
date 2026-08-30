import assert from "node:assert/strict";
import {
  getWallet,
  propose,
  vote,
  getProposal,
  execute,
  resetState,
  handleRequest,
} from "./route.mjs";

resetState();

// ---------------------------------------------------------------------------
// Wallets: weights, not a signer count.
// ---------------------------------------------------------------------------
const team = getWallet("GW_TEAM");
assert.equal(team.status, 200);
assert.equal(team.payload.threshold, 3);
assert.equal(team.payload.totalWeight, 5);
assert.equal(team.payload.signers.find((s) => s.id === "alice").weight, 2);

assert.equal(getWallet("GW_NOBODY").status, 404);
assert.equal(getWallet("GW_NOBODY").payload.error, "wallet_not_found");
assert.ok(getWallet(undefined).payload.knownWallets.includes("GW_TEAM"));

// ---------------------------------------------------------------------------
// Proposing is signing: the proposer's weight counts from the start.
// ---------------------------------------------------------------------------
const p = propose({ wallet: "GW_TEAM", proposer: "alice", operation: "pay 500 XLM to GA_VENDOR" });
assert.equal(p.status, 201);
assert.equal(p.payload.proposer, "alice");
assert.equal(p.payload.operation, "pay 500 XLM to GA_VENDOR");
assert.equal(p.payload.status, "pending");
assert.equal(p.payload.approvedWeight, 2, "alice's weight, not one vote");
assert.equal(p.payload.rejectedWeight, 0);
assert.equal(p.payload.undecidedWeight, 3);
assert.equal(p.payload.maxAttainable, 5);
assert.equal(p.payload.readyToExecute, false);
assert.equal(p.payload.votes.length, 1);
assert.deepEqual(p.payload.awaiting, ["bob", "carol", "dave"]);
assert.equal(p.payload.execution, null);

// A non-signer cannot propose.
let refused = propose({ wallet: "GW_TEAM", proposer: "mallory", operation: "drain it" });
assert.equal(refused.status, 403);
assert.equal(refused.payload.error, "not_a_signer");
assert.ok(refused.payload.signers.includes("alice"));

// Validation.
assert.equal(propose({ wallet: "GW_NOBODY", proposer: "alice", operation: "x" }).status, 404);
assert.equal(propose({ wallet: "GW_TEAM", operation: "x" }).payload.field, "proposer");
assert.equal(
  propose({ wallet: "GW_TEAM", proposer: "  ", operation: "x" }).payload.field,
  "proposer",
);
assert.equal(propose({ wallet: "GW_TEAM", proposer: "alice" }).payload.field, "operation");
assert.equal(
  propose({ wallet: "GW_TEAM", proposer: "alice", operation: "  " }).payload.field,
  "operation",
);
assert.equal(propose({}).status, 404);

// ---------------------------------------------------------------------------
// Collecting votes until the weight -- not the headcount -- clears.
// ---------------------------------------------------------------------------
// carol rejects: 2 approved, 1 rejected, 2 undecided. Max attainable 4 >= 3,
// so this is still live even though a signer is against it.
let after = vote({ id: p.payload.id, signer: "carol", vote: "reject" });
assert.equal(after.status, 200);
assert.equal(after.payload.status, "pending");
assert.equal(after.payload.approvedWeight, 2);
assert.equal(after.payload.rejectedWeight, 1);
assert.equal(after.payload.maxAttainable, 4);
assert.deepEqual(after.payload.awaiting, ["bob", "dave"]);

// bob approves: 3 >= threshold 3. Two of four signers, and it passes.
after = vote({ id: p.payload.id, signer: "bob", vote: "approve" });
assert.equal(after.payload.status, "ready");
assert.equal(after.payload.approvedWeight, 3);
assert.equal(after.payload.readyToExecute, true);
assert.deepEqual(after.payload.awaiting, ["dave"], "ready before everyone has voted");

// Voting is closed once the threshold is reached -- dave's vote cannot change it.
refused = vote({ id: p.payload.id, signer: "dave", vote: "reject" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "voting_closed");
assert.equal(refused.payload.status, "ready");
assert.equal(getProposal(p.payload.id).payload.approvedWeight, 3, "the refusal recorded nothing");

// ---------------------------------------------------------------------------
// Execution latches. This is the classic multisig bug.
// ---------------------------------------------------------------------------
const executed = execute({ id: p.payload.id, executor: "dave" });
assert.equal(executed.status, 200);
assert.equal(executed.payload.status, "executed");
assert.equal(executed.payload.alreadyExecuted, false);
assert.ok(executed.payload.execution.txHash);
assert.equal(executed.payload.execution.executedBy, "dave");
// The execution pins the tally it ran against.
assert.equal(executed.payload.execution.approvedWeight, 3);
assert.equal(executed.payload.execution.threshold, 3);
assert.deepEqual(executed.payload.execution.approvedBy, ["alice", "bob"]);

const again = execute({ id: p.payload.id, executor: "alice" });
assert.equal(again.status, 200);
assert.equal(again.payload.alreadyExecuted, true);
assert.equal(again.payload.execution.txHash, executed.payload.execution.txHash, "no second run");
assert.equal(again.payload.execution.executedBy, "dave", "the original executor stands");
assert.equal(again.payload.execution.executedAt, executed.payload.execution.executedAt);

// An executed proposal takes no more votes.
assert.equal(
  vote({ id: p.payload.id, signer: "dave", vote: "approve" }).payload.error,
  "voting_closed",
);

// ---------------------------------------------------------------------------
// A proposal dies once it cannot reach the threshold, before every vote is in.
// GW_UNANIMOUS needs all 4; one reject ends it.
// ---------------------------------------------------------------------------
const doomed = propose({ wallet: "GW_UNANIMOUS", proposer: "erin", operation: "rotate signers" });
assert.equal(doomed.payload.status, "pending");
assert.equal(doomed.payload.maxAttainable, 4);

const killed = vote({ id: doomed.payload.id, signer: "frank", vote: "reject" });
assert.equal(killed.payload.status, "rejected");
assert.equal(killed.payload.approvedWeight, 1);
assert.equal(killed.payload.maxAttainable, 3, "below the threshold of 4, so it is decided");
assert.equal(killed.payload.readyToExecute, false);
assert.deepEqual(killed.payload.awaiting, ["grace", "heidi"], "still listed, but they cannot help");

// The remaining signers cannot revive it, and it cannot be executed.
assert.equal(
  vote({ id: doomed.payload.id, signer: "grace", vote: "approve" }).payload.error,
  "voting_closed",
);
refused = execute({ id: doomed.payload.id, executor: "erin" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "proposal_rejected");

// ---------------------------------------------------------------------------
// A wallet whose threshold the proposer alone meets is ready at proposal time.
// ---------------------------------------------------------------------------
const solo = propose({ wallet: "GW_SOLO", proposer: "solo", operation: "pay 1 XLM" });
assert.equal(solo.payload.status, "ready");
assert.equal(solo.payload.readyToExecute, true);
assert.deepEqual(solo.payload.awaiting, []);
assert.equal(execute({ id: solo.payload.id, executor: "solo" }).payload.status, "executed");

// ---------------------------------------------------------------------------
// Duplicate votes are refused, not overwritten -- including the proposer's own
// implicit approval, which is why `viaProposal` is on the error.
// ---------------------------------------------------------------------------
const dup = propose({ wallet: "GW_TEAM", proposer: "alice", operation: "second payment" });
refused = vote({ id: dup.payload.id, signer: "alice", vote: "reject" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "already_voted");
assert.equal(refused.payload.recordedVote, "approve");
assert.equal(refused.payload.viaProposal, true);
assert.equal(getProposal(dup.payload.id).payload.approvedWeight, 2, "unchanged");

// carol rejects rather than approves: an approval would put the weight at 3 and
// close voting, which is a different refusal than the one under test here.
assert.equal(
  vote({ id: dup.payload.id, signer: "carol", vote: "reject" }).payload.status,
  "pending",
);
refused = vote({ id: dup.payload.id, signer: "carol", vote: "approve" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "already_voted");
assert.equal(refused.payload.recordedVote, "reject");
assert.equal(refused.payload.viaProposal, false);

// ---------------------------------------------------------------------------
// Executing before the threshold is reached.
// ---------------------------------------------------------------------------
const early = propose({ wallet: "GW_TEAM", proposer: "bob", operation: "third payment" });
assert.equal(early.payload.approvedWeight, 1);
refused = execute({ id: early.payload.id, executor: "bob" });
assert.equal(refused.status, 409);
assert.equal(refused.payload.error, "threshold_not_reached");
assert.equal(refused.payload.approvedWeight, 1);
assert.equal(refused.payload.threshold, 3);
assert.deepEqual(refused.payload.awaiting, ["alice", "carol", "dave"]);
assert.equal(getProposal(early.payload.id).payload.execution, null, "nothing was executed");

// A non-signer cannot execute, even a proposal that is ready.
assert.equal(
  vote({ id: early.payload.id, signer: "alice", vote: "approve" }).payload.status,
  "ready",
);
refused = execute({ id: early.payload.id, executor: "mallory" });
assert.equal(refused.status, 403);
assert.equal(refused.payload.error, "not_a_signer");
assert.equal(getProposal(early.payload.id).payload.execution, null);

// ---------------------------------------------------------------------------
// Lookup, validation and isolation.
// ---------------------------------------------------------------------------
assert.equal(getProposal("nope").status, 404);
assert.equal(getProposal("").status, 400);
assert.equal(vote({ id: "nope", signer: "alice", vote: "approve" }).status, 404);
assert.equal(vote({ id: dup.payload.id, signer: "alice", vote: "maybe" }).payload.field, "vote");
assert.equal(vote({ id: dup.payload.id, signer: "alice" }).payload.received, null);
assert.equal(vote({ id: dup.payload.id }).payload.field, "signer");
assert.equal(vote({}).payload.field, "id");
assert.equal(vote({ id: dup.payload.id, signer: "mallory", vote: "approve" }).status, 403);
assert.equal(execute({ id: "nope", executor: "alice" }).status, 404);
assert.equal(execute({ id: dup.payload.id }).payload.field, "executor");
assert.equal(execute({}).payload.field, "id");

// Proposals on the same wallet are independent.
assert.equal(getProposal(dup.payload.id).payload.status, "pending");
assert.equal(getProposal(p.payload.id).payload.status, "executed");

// A mutated response must not corrupt stored state.
const snapshot = getProposal(dup.payload.id);
snapshot.payload.votes[0].vote = "reject";
snapshot.payload.status = "executed";
snapshot.payload.awaiting.push("tampered");
assert.equal(getProposal(dup.payload.id).payload.votes[0].vote, "approve");
assert.equal(getProposal(dup.payload.id).payload.status, "pending");
assert.ok(!getProposal(dup.payload.id).payload.awaiting.includes("tampered"));
getWallet("GW_TEAM").payload.signers[0].weight = 99;
assert.equal(getWallet("GW_TEAM").payload.signers[0].weight, 2);

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------
assert.equal(handleRequest("GET", "/wallet", undefined, { id: "GW_TEAM" }).status, 200);
const routed = handleRequest("POST", "/propose", {
  wallet: "GW_TEAM",
  proposer: "carol",
  operation: "routed payment",
});
assert.equal(routed.status, 201);
assert.equal(handleRequest("GET", "/proposal", undefined, { id: routed.payload.id }).status, 200);
assert.equal(
  handleRequest("POST", "/vote", { id: routed.payload.id, signer: "alice", vote: "approve" })
    .payload.status,
  "ready",
);
assert.equal(
  handleRequest("POST", "/execute", { id: routed.payload.id, executor: "alice" }).payload.status,
  "executed",
);
assert.equal(handleRequest("GET", "/propose", undefined, {}).status, 404);
assert.equal(handleRequest("POST", "/nope", {}).status, 404);

// resetState clears every proposal; the wallets are static and survive.
resetState();
assert.equal(getProposal(routed.payload.id).status, 404);
assert.equal(getWallet("GW_TEAM").status, 200);

console.log(
  "PASS: /propose signs on behalf of the proposer, /vote tallies signer weight against the threshold, and /execute runs exactly once",
);
