import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  consumeSponsorBudget,
  enforceBalanceFloor,
  enforceFeeCap,
  needsSponsorRebuild,
  SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS,
  SPONSOR_DEFAULT_MAX_FEE_STROOPS,
} from "./sponsor";
import { SubmissionError } from "./relayer";

const PASSPHRASE = "Test SDF Network ; September 2015";
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// RA-9/FIX-1: needsSponsorRebuild had NO test. Its filter is a NEGATIVE match
// (accept unless sorobanCredentialsSourceAccount), so it correctly accepts the
// V2 credentials passkey-kit@0.14 actually emits — but that was safe by luck,
// not by test. These fixtures build the REAL V2 shape (plus V1/delegates/
// source-account) so a regression to a positive V1-only check fails here.
type CredKind = "v1" | "v2" | "delegates" | "source";

function addrCreds(subject: string): xdr.SorobanAddressCredentials {
  return new xdr.SorobanAddressCredentials({
    address: Address.fromString(subject).toScAddress(),
    nonce: xdr.Int64.fromString("0"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
}

function credentialsFor(subject: string, kind: CredKind): xdr.SorobanCredentials {
  switch (kind) {
    case "source":
      return xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
    case "v1":
      return xdr.SorobanCredentials.sorobanCredentialsAddress(addrCreds(subject));
    case "v2":
      return xdr.SorobanCredentials.sorobanCredentialsAddressV2(addrCreds(subject));
    case "delegates":
      return xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: addrCreds(subject),
          delegates: [],
        }),
      );
  }
}

function invokeOp(authKinds: CredKind[]): xdr.Operation {
  const auth = authKinds.map(
    (kind) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: credentialsFor(WALLET, kind),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(WALLET).toScAddress(),
              functionName: "transfer",
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      }),
  );
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(WALLET).toScAddress(),
        functionName: "transfer",
        args: [],
      }),
    ),
    auth,
  });
}

/** Build a signed-shaped tx from operations, so needsSponsorRebuild parses it. */
function buildTx(ops: xdr.Operation[]): string {
  const account = new Account(Keypair.random().publicKey(), "0");
  const b = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE });
  for (const op of ops) b.addOperation(op);
  return b.setTimeout(30).build().toXDR();
}

describe("enforceFeeCap", () => {
  it("accepts a simulated fee at or below the cap", () => {
    expect(() => enforceFeeCap("100000", SPONSOR_DEFAULT_MAX_FEE_STROOPS)).not.toThrow();
    expect(() =>
      enforceFeeCap(SPONSOR_DEFAULT_MAX_FEE_STROOPS, SPONSOR_DEFAULT_MAX_FEE_STROOPS),
    ).not.toThrow();
  });

  it("rejects a simulated fee above the cap with a coded SubmissionError", () => {
    // The old hardcoded 1-XLM bid (10,000,000) is now rejected by the default
    // 0.1-XLM (1,000,000) cap.
    let thrown: unknown;
    try {
      enforceFeeCap("10000000", SPONSOR_DEFAULT_MAX_FEE_STROOPS);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubmissionError);
    expect(thrown).toMatchObject({ code: "sponsor_fee_too_high" });
  });

  it("default cap is 0.1 XLM (1,000,000 stroops), a 10x reduction from the old 1-XLM ceiling", () => {
    expect(SPONSOR_DEFAULT_MAX_FEE_STROOPS).toBe("1000000");
  });

  it("honors a custom (looser) cap", () => {
    expect(() => enforceFeeCap("5000000", "10000000")).not.toThrow();
    expect(() => enforceFeeCap("10000001", "10000000")).toThrow(SubmissionError);
  });
});

describe("enforceBalanceFloor", () => {
  it("accepts a balance strictly above the floor", () => {
    expect(() =>
      enforceBalanceFloor("20000000", SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS),
    ).not.toThrow();
    expect(() => enforceBalanceFloor("10000001", "10000000")).not.toThrow();
  });

  it("rejects a balance at or below the floor with code sponsor_balance_below_floor", () => {
    let thrownAtFloor: unknown;
    try {
      enforceBalanceFloor(
        SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS,
        SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS,
      );
    } catch (err) {
      thrownAtFloor = err;
    }
    expect(thrownAtFloor).toBeInstanceOf(SubmissionError);
    expect(thrownAtFloor).toMatchObject({ code: "sponsor_balance_below_floor" });

    let thrownBelowFloor: unknown;
    try {
      enforceBalanceFloor("5000000", SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS);
    } catch (err) {
      thrownBelowFloor = err;
    }
    expect(thrownBelowFloor).toBeInstanceOf(SubmissionError);
    expect(thrownBelowFloor).toMatchObject({ code: "sponsor_balance_below_floor" });
  });

  it("default balance floor is 1.0 XLM (10,000,000 stroops)", () => {
    expect(SPONSOR_DEFAULT_BALANCE_FLOOR_STROOPS).toBe("10000000");
  });

  it("invokes onFloorReached callback when floor is reached or breached", () => {
    const events: Array<{ current: string; floor: string }> = [];
    const callback = (current: string, floor: string) => {
      events.push({ current, floor });
    };

    expect(() => enforceBalanceFloor("9000000", "10000000", callback)).toThrow(SubmissionError);
    expect(events).toEqual([{ current: "9000000", floor: "10000000" }]);
  });
});

describe("consumeSponsorBudget (FIX 3, fails closed)", () => {
  it("no-ops when no budget is wired", async () => {
    await expect(consumeSponsorBudget("100", undefined, undefined)).resolves.toBeUndefined();
    await expect(
      consumeSponsorBudget("100", { tryConsume: async () => ({ ok: true }) }, undefined),
    ).resolves.toBeUndefined();
  });

  it("consumes the sponsor line with the real fee and proceeds when allowed", async () => {
    const calls: unknown[] = [];
    const budget = {
      tryConsume: async (req: unknown) => {
        calls.push(req);
        return { ok: true as const };
      },
    };
    await expect(consumeSponsorBudget("12345", budget, "testnet")).resolves.toBeUndefined();
    expect(calls[0]).toEqual({ line: "sponsor", network: "testnet", stroops: 12345n });
  });

  it("throws sponsor_budget_exceeded when the budget refuses", async () => {
    const budget = { tryConsume: async () => ({ ok: false as const, reason: "budget_exceeded" }) };
    const attempt = consumeSponsorBudget("100", budget, "mainnet");
    await expect(attempt).rejects.toBeInstanceOf(SubmissionError);
    await expect(attempt).rejects.toMatchObject({ code: "sponsor_budget_exceeded" });
  });

  it("fails closed: an accounting error refuses (does not proceed)", async () => {
    const budget = {
      tryConsume: async () => {
        throw new Error("db down");
      },
    };
    await expect(consumeSponsorBudget("100", budget, "testnet")).rejects.toMatchObject({
      code: "sponsor_budget_exceeded",
    });
  });
});

describe("needsSponsorRebuild (routing predicate — RA-9/FIX-1)", () => {
  it.each(["v2", "v1", "delegates"] as const)(
    "returns true for a single-op invoke with a %s address credential (the sponsor-rebuild shape)",
    (kind) => {
      // V2 is what passkey-kit@0.14 actually signs; all address-bound variants
      // must route to the sponsor rebuild, none skipped.
      expect(needsSponsorRebuild(buildTx([invokeOp([kind])]), PASSPHRASE)).toBe(true);
    },
  );

  it("returns false when ANY auth entry is source-account (a deploy — relayer handles it)", () => {
    expect(needsSponsorRebuild(buildTx([invokeOp(["source"])]), PASSPHRASE)).toBe(false);
    // Mixed: one address + one source-account still fails the every() guard.
    expect(needsSponsorRebuild(buildTx([invokeOp(["v2", "source"])]), PASSPHRASE)).toBe(false);
  });

  it("returns false for a multi-op tx (only single-op invokes are rebuilt)", () => {
    expect(needsSponsorRebuild(buildTx([invokeOp(["v2"]), invokeOp(["v2"])]), PASSPHRASE)).toBe(
      false,
    );
  });

  it("returns false for an invoke with empty auth (nothing to attribute)", () => {
    expect(needsSponsorRebuild(buildTx([invokeOp([])]), PASSPHRASE)).toBe(false);
  });

  it("returns false for a non-invokeHostFunction op", () => {
    const bump = Operation.bumpSequence({ bumpTo: "0" });
    expect(needsSponsorRebuild(buildTx([bump]), PASSPHRASE)).toBe(false);
  });

  it("returns false for an unparseable xdr rather than throwing", () => {
    expect(needsSponsorRebuild("not-an-xdr", PASSPHRASE)).toBe(false);
  });
});
