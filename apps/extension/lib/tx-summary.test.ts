import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Operation,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  formatOperationSummary,
  formatStroops,
  formatTransactionBatchSummary,
  summarizeTransaction,
} from "./tx-summary";

// Build real transaction XDRs and decode them through the summarizer, so the
// decode path is exercised for real rather than against a hand-rolled mock.

const PASSPHRASE = "Test SDF Network ; September 2015";
const sdk = { TransactionBuilder, Address, scValToNative };

/** A valid random contract id (C…), checksum included. */
function contractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

const SOURCE = Keypair.random().publicKey();
const WALLET = contractId();
const TOKEN = contractId();
const DEST = contractId();
const ROUTER = contractId();

function buildTx(op: xdr.Operation): string {
  const account = new Account(SOURCE, "0");
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}

function transferOp(amount: string) {
  return Operation.invokeContractFunction({
    contract: TOKEN,
    function: "transfer",
    args: [
      nativeToScVal(Address.fromString(WALLET), { type: "address" }),
      nativeToScVal(Address.fromString(DEST), { type: "address" }),
      nativeToScVal(BigInt(amount), { type: "i128" }),
    ],
  });
}

describe("summarizeTransaction", () => {
  it("summarizes a SEP-41 transfer with the amount and destination", () => {
    const xdrStr = buildTx(transferOp("50000000")); // 5 XLM
    const summary = summarizeTransaction(xdrStr, "testnet", sdk);

    expect(summary.movesValue).toBe(true);
    expect(summary.isBatch).toBe(false);
    expect(summary.operations).toHaveLength(1);
    const op = summary.operations[0]!;
    expect(op.kind).toBe("transfer");
    if (op.kind === "transfer") {
      expect(op.amount).toBe("50000000");
      expect(op.to).toBe(DEST);
      expect(op.token).toBe(TOKEN);
    }
  });

  it("summarizes a non-transfer contract call by function name", () => {
    const op = Operation.invokeContractFunction({
      contract: TOKEN,
      function: "approve",
      args: [nativeToScVal(1, { type: "u32" })],
    });
    const summary = summarizeTransaction(buildTx(op), "testnet", sdk);

    expect(summary.movesValue).toBe(false);
    const first = summary.operations[0]!;
    expect(first.kind).toBe("contract-call");
    if (first.kind === "contract-call") {
      expect(first.fn).toBe("approve");
      expect(first.contract).toBe(TOKEN);
    }
  });

  it("flags value movement across a batch containing a transfer", () => {
    const approve = Operation.invokeContractFunction({
      contract: TOKEN,
      function: "approve",
      args: [nativeToScVal(1, { type: "u32" })],
    });
    const account = new Account(SOURCE, "0");
    const xdrStr = new TransactionBuilder(account, {
      fee: "200",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(approve)
      .addOperation(transferOp("10000000"))
      .setTimeout(30)
      .build()
      .toXDR();

    const summary = summarizeTransaction(xdrStr, "testnet", sdk);
    expect(summary.operations).toHaveLength(2);
    expect(summary.movesValue).toBe(true);
    expect(summary.isBatch).toBe(true);
  });

  it("summarizes a Soroban multi-operation batch transaction and formats each step in order (#577)", () => {
    const approveOp = Operation.invokeContractFunction({
      contract: TOKEN,
      function: "approve",
      args: [nativeToScVal(1, { type: "u32" })],
    });
    const swapOp = Operation.invokeContractFunction({
      contract: ROUTER,
      function: "swap_exact_tokens",
      args: [nativeToScVal(25_000_000n, { type: "i128" })],
    });
    const account = new Account(SOURCE, "0");
    const xdrStr = new TransactionBuilder(account, {
      fee: "300",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(approveOp)
      .addOperation(transferOp("25000000"))
      .addOperation(swapOp)
      .setTimeout(30)
      .build()
      .toXDR();

    const summary = summarizeTransaction(xdrStr, "testnet", sdk);
    expect(summary.isBatch).toBe(true);
    expect(summary.movesValue).toBe(true);
    expect(summary.operations).toEqual([
      { kind: "contract-call", contract: TOKEN, fn: "approve" },
      { kind: "transfer", token: TOKEN, to: DEST, amount: "25000000" },
      { kind: "contract-call", contract: ROUTER, fn: "swap_exact_tokens" },
    ]);

    const lines = formatTransactionBatchSummary(summary);
    expect(lines).toEqual([
      `Step 1 of 3: Call approve on ${TOKEN.slice(0, 6)}…${TOKEN.slice(-6)}`,
      `Step 2 of 3: Send 2.5 XLM → ${DEST.slice(0, 6)}…${DEST.slice(-6)}`,
      `Step 3 of 3: Call swap_exact_tokens on ${ROUTER.slice(0, 6)}…${ROUTER.slice(-6)}`,
    ]);
  });

  it("expands a Soroban smart-wallet execute_batch call and falls back gracefully on unrecognized sub-operations (#577)", () => {
    const batchCallOp = Operation.invokeContractFunction({
      contract: WALLET,
      function: "execute_batch",
      args: [xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)])],
    });
    const summary = summarizeTransaction(buildTx(batchCallOp), "testnet", {
      TransactionBuilder,
      Address,
      scValToNative: () => [
        { contract: TOKEN, fn: "approve", args: [WALLET, ROUTER, "10000000"] },
        { contract: TOKEN, fn: "transfer", args: [WALLET, DEST, "10000000"] },
        { malformed: true },
      ],
    });

    expect(summary.isBatch).toBe(true);
    expect(summary.movesValue).toBe(true);
    expect(summary.operations).toEqual([
      { kind: "contract-call", contract: TOKEN, fn: "approve" },
      { kind: "transfer", token: TOKEN, to: DEST, amount: "10000000" },
      { kind: "other", label: "Unrecognized batch operation" },
    ]);
    expect(formatOperationSummary(summary.operations[2]!, 2, 3)).toBe(
      "Step 3 of 3: Operation: Unrecognized batch operation",
    );
  });

  it("degrades to a safe generic summary for undecodable input", () => {
    const summary = summarizeTransaction("not-valid-xdr", "testnet", sdk);
    expect(summary.undecoded).toBe(true);
    expect(summary.movesValue).toBe(false);
    expect(summary.operations[0]).toEqual({ kind: "other", label: "a transaction" });
  });
});

describe("formatStroops", () => {
  it.each([
    ["10000000", "1"],
    ["50000000", "5"],
    ["12500000", "1.25"],
    ["1", "0.0000001"],
  ])("%s stroops → %s XLM", (stroops, xlm) => {
    expect(formatStroops(stroops)).toBe(xlm);
  });

  it("returns the input unchanged when it is not a number", () => {
    expect(formatStroops("abc")).toBe("abc");
  });
});
