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
import { formatStroops, summarizeTransaction } from "./tx-summary";

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
