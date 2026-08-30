import assert from "node:assert/strict";
import { classifyContext, evaluateTransactionSafety, handleRequest } from "./route.mjs";

const CONFIG = { maxTransferAmount: 100 };

// --- An allowed transfer reports allowed ---
{
  const result = evaluateTransactionSafety(CONFIG, [
    { contract: "CTOKEN", fnName: "transfer", args: ["from", "GDEST", 50] },
  ]);
  assert.equal(result.verdict, "allowed");
  assert.equal(result.interactions[0].classification, "transfer");
  assert.equal(result.interactions[0].decision, "allowed");
}

// --- A transfer over the limit reports its own rule: max-transfer-amount ---
{
  const result = evaluateTransactionSafety(CONFIG, [
    { contract: "CTOKEN", fnName: "transfer", args: ["from", "GDEST", 900] },
  ]);
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rule, "max-transfer-amount");
  assert.match(result.reason, /exceeds maxTransferAmount 100/);
}

// --- A non-transfer contract call reports its own rule: non-transfer-call ---
{
  const result = evaluateTransactionSafety(CONFIG, [
    { contract: "CSWAP", fnName: "swap_exact_in", args: ["from", "GDEST", 10] },
  ]);
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rule, "non-transfer-call");
  assert.match(result.reason, /only allows token transfers/);
}

// --- An unclassifiable interaction honestly reports unknown, not "safe" ---
{
  const malformedTransfer = evaluateTransactionSafety(CONFIG, [
    { contract: "CTOKEN", fnName: "transfer", args: ["from"] }, // missing to/amount
  ]);
  assert.equal(malformedTransfer.verdict, "rejected");
  assert.equal(malformedTransfer.rule, "unknown-interaction");
  assert.equal(malformedTransfer.interactions[0].classification, "unknown");

  const garbage = evaluateTransactionSafety(CONFIG, [{ nonsense: true }]);
  assert.equal(garbage.verdict, "rejected");
  assert.equal(garbage.rule, "unknown-interaction");

  const zeroAmount = classifyContext({
    contract: "CTOKEN",
    fnName: "transfer",
    args: ["from", "GDEST", 0],
  });
  assert.equal(zeroAmount.type, "unknown");
}

// --- An empty context list is rejected, mirroring the contract's behavior ---
{
  const result = evaluateTransactionSafety(CONFIG, []);
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rule, "no-interactions");
}

// --- Matches the contract verdict for the covered cases ---
// Traced directly against contrib/contracts/safety-policy/src/lib.rs:
// TokenTransfer with amount > max_transfer_amount -> panic(NotAllowed);
// OtherContractCall -> panic(NotAllowed); Unknown -> panic(NotAllowed);
// TokenTransfer with amount <= max_transfer_amount -> no panic (allowed).
// The contract has no "allowed" return value -- allowed simply means it does
// not panic -- so "matches the contract" here means: rejects in exactly the
// same cases the contract would panic in, and only in those cases.
{
  const cases = [
    { args: ["from", "GDEST", 100], expectAllowed: true }, // exactly at the limit
    { args: ["from", "GDEST", 101], expectAllowed: false },
  ];
  for (const { args, expectAllowed } of cases) {
    const result = evaluateTransactionSafety(CONFIG, [
      { contract: "CTOKEN", fnName: "transfer", args },
    ]);
    assert.equal(result.verdict, expectAllowed ? "allowed" : "rejected");
  }
}

// --- Several interactions: the first rejection wins, mirroring the
// contract's loop, which panics on the first violation and never reaches
// the rest ---
{
  const result = evaluateTransactionSafety(CONFIG, [
    { contract: "CSWAP", fnName: "swap_exact_in", args: [] },
    { contract: "CTOKEN", fnName: "transfer", args: ["from", "GDEST", 50] },
  ]);
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rule, "non-transfer-call");
}

// --- HTTP-shaped handler: validation ---
{
  assert.equal(handleRequest({ body: {} }).status, 400);
  assert.equal(handleRequest({ body: { config: { maxTransferAmount: 0 } } }).status, 400);
  assert.equal(handleRequest({ body: { config: CONFIG, contexts: "nope" } }).status, 400);
  const ok = handleRequest({
    body: {
      config: CONFIG,
      contexts: [{ contract: "CTOKEN", fnName: "transfer", args: ["f", "GDEST", 5] }],
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verdict, "allowed");
}

console.log("PASS: transaction rejection explainer matches safety-policy contract rules");
