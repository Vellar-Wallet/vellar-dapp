import {
  Account,
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAndRecordAttach, type DeploymentDeps } from "./deployment";
import {
  AttachMismatchError,
  AttachTimeoutError,
  AttachUnconfirmedError,
  verifyAttachTx,
  type TxLookup,
  type TxResult,
} from "./verify-attach";
import type { PolicyRecord, PolicyRepository } from "./server";

/**
 * #829: the local timeout fires first, and a moment later the chain's real answer arrives as a
 * genuine rejection (a FAILED transaction, not a late success). The timeout must stay a retryable
 * "we do not know yet"; it must not be mistaken for the answer, must not leave the policy stamped
 * or half-stamped, and the next verification must reach the definite "failed" verdict.
 */

const PASSPHRASE = "Test SDF Network ; September 2015";
const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POLICY = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
const TARGET = { txHash: "attach-tx", network: "testnet" as const, wallet: WALLET, policyContractId: POLICY };

const TIMEOUT_MS = 20;
const LATE_MS = 60;

function attachEnvelope(): string {
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Policy"),
    nativeToScVal(Address.fromString(POLICY), { type: "address" }),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Persistent")]),
  ]);
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(WALLET).toScAddress(),
      functionName: "add_signer",
      args: [signer],
    }),
  );
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(30)
    .build()
    .toXDR();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lookup that answers `result` only after `delayMs`, like a slow RPC node. */
function slow(result: TxResult | Error, delayMs = LATE_MS): TxLookup {
  return () =>
    new Promise((resolve, reject) =>
      setTimeout(() => (result instanceof Error ? reject(result) : resolve(result)), delayMs),
    );
}

const withTimeout = (lookup: TxLookup) =>
  verifyAttachTx(lookup, TARGET, { networkPassphrase: PASSPHRASE, timeoutMs: TIMEOUT_MS });

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

describe("verifyAttachTx: timeout, then a genuine on-chain rejection", () => {
  it("reports the timeout, not the late rejection, when the timeout fires first", async () => {
    const error = await rejection(withTimeout(slow({ status: "FAILED" })));

    expect(error).toBeInstanceOf(AttachTimeoutError);
    expect(error).not.toBeInstanceOf(AttachMismatchError);
    expect(error).not.toBeInstanceOf(AttachUnconfirmedError);
    expect((error as AttachTimeoutError).code).toBe("attach_timeout");
    expect((error as AttachTimeoutError).retryable).toBe(true);
  });

  it("lets the late FAILED answer land without an unhandled rejection or a second error", async () => {
    const error = await rejection(withTimeout(slow({ status: "FAILED" })));
    await sleep(LATE_MS + 40);

    expect(error).toBeInstanceOf(AttachTimeoutError);
    expect(unhandled).toEqual([]);
  });

  it("lets a late RPC error land quietly too", async () => {
    const error = await rejection(withTimeout(slow(new Error("rpc connection reset"))));
    await sleep(LATE_MS + 40);

    expect(error).toBeInstanceOf(AttachTimeoutError);
    expect(unhandled).toEqual([]);
  });

  it("names the transaction and the wait in the timeout message", async () => {
    const error = await rejection(withTimeout(slow({ status: "FAILED" })));

    expect(error.message).toContain("attach-tx");
    expect(error.message).toContain(`${TIMEOUT_MS}ms`);
  });

  it("reaches the definite verdict on the next attempt: FAILED is a mismatch, not another timeout", async () => {
    const chain = { landed: false };
    const lookup: TxLookup = () => {
      if (chain.landed) return Promise.resolve({ status: "FAILED" });
      // First look: the node is slow, and the answer it will eventually give is FAILED.
      return new Promise((resolve) =>
        setTimeout(() => {
          chain.landed = true;
          resolve({ status: "FAILED" });
        }, LATE_MS),
      );
    };

    const first = await rejection(withTimeout(lookup));
    await sleep(LATE_MS + 40);
    const second = await rejection(withTimeout(lookup));

    expect(first).toBeInstanceOf(AttachTimeoutError);
    expect(second).toBeInstanceOf(AttachMismatchError);
    expect((second as AttachMismatchError).code).toBe("attach_mismatch");
    expect(second).not.toHaveProperty("retryable");
    expect(second.message).toContain("did not succeed on-chain");
  });

  it("does not remember the timeout: a fast FAILED straight afterwards is judged on its own", async () => {
    await rejection(withTimeout(slow({ status: "FAILED" })));

    const error = await rejection(withTimeout(async () => ({ status: "FAILED" })));

    expect(error).toBeInstanceOf(AttachMismatchError);
  });

  it("still accepts a success that arrives promptly after an earlier timeout", async () => {
    await rejection(withTimeout(slow({ status: "FAILED" })));

    await expect(
      withTimeout(async () => ({ status: "SUCCESS", envelopeXdr: attachEnvelope() })),
    ).resolves.toBeUndefined();
  });

  it("treats a timeout that never gets any answer the same way", async () => {
    const never: TxLookup = () => new Promise(() => {});

    const error = await rejection(withTimeout(never));

    expect(error).toBeInstanceOf(AttachTimeoutError);
    expect(unhandled).toEqual([]);
  });
});

describe("verifyAndRecordAttach: a timeout never stamps or strands the policy", () => {
  function setup() {
    const store = new Map<string, PolicyRecord>();
    const update = vi.fn(async (record: PolicyRecord) => {
      store.set(record.id, { ...record });
    });
    const repo = {
      insert: vi.fn(),
      find: vi.fn(),
      update,
      listPage: vi.fn(),
    } as unknown as PolicyRepository;
    const record: PolicyRecord = {
      id: "policy-829",
      createdAt: "2026-08-29T11:00:00.000Z",
      status: "instance_deployed",
      definition: {
        version: "1",
        type: "spending_limit",
        owners: [WALLET],
        spendingLimits: { dailyXlm: "100" },
      },
      policyHash: "hash",
      manifest: {
        template: "spending_limit",
        enforcement: { kind: "policy-contract", wasmHash: "wasm", constructorArgs: {} },
        network: "testnet",
      },
      instance: {
        contractId: POLICY,
        wallet: WALLET,
        txHash: "deploy-tx",
        deployedAt: "2026-08-29T11:30:00.000Z",
      },
    } as PolicyRecord;
    const attempt = (lookup: TxLookup) => {
      const deps = {
        policies: repo,
        verifyAttach: lookup,
        verifyAttachTx: (l: TxLookup, t: typeof TARGET, passphrase: string) =>
          verifyAttachTx(l, t, { networkPassphrase: passphrase, timeoutMs: TIMEOUT_MS }),
        network: "testnet",
        networkPassphrase: PASSPHRASE,
        now: () => new Date("2026-08-29T12:00:00.000Z"),
      } as unknown as DeploymentDeps;
      return verifyAndRecordAttach(deps, record, "attach-tx", POLICY);
    };
    return { record, update, attempt, store };
  }

  it("leaves the record exactly as it was when the verification times out", async () => {
    const { record, update, attempt } = setup();

    const error = await rejection(attempt(slow({ status: "FAILED" })));
    await sleep(LATE_MS + 40);

    expect(error).toBeInstanceOf(AttachTimeoutError);
    expect(update).not.toHaveBeenCalled();
    expect(record.status).toBe("instance_deployed");
    expect(record.deployment).toBeUndefined();
  });

  it("is not stuck: the retry reaches a definite failure and the record is still not deployed", async () => {
    const { record, update, attempt } = setup();
    await rejection(attempt(slow({ status: "FAILED" })));
    await sleep(LATE_MS + 40);

    const retry = await rejection(attempt(async () => ({ status: "FAILED" })));

    expect(retry).toBeInstanceOf(AttachMismatchError);
    expect(update).not.toHaveBeenCalled();
    expect(record.status).toBe("instance_deployed");
    expect(record.deployment).toBeUndefined();
  });

  it("repeated timeouts followed by a rejection still end in the one definite verdict", async () => {
    const { attempt } = setup();

    const timeouts = [
      await rejection(attempt(slow({ status: "FAILED" }))),
      await rejection(attempt(slow({ status: "FAILED" }))),
    ];
    const verdict = await rejection(attempt(async () => ({ status: "FAILED" })));
    await sleep(LATE_MS + 40);

    expect(timeouts.every((error) => error instanceof AttachTimeoutError)).toBe(true);
    expect(verdict).toBeInstanceOf(AttachMismatchError);
    expect(unhandled).toEqual([]);
  });

  it("stamps the policy only when a later attempt really confirms the attach", async () => {
    const { record, update, attempt } = setup();
    await rejection(attempt(slow({ status: "FAILED" })));

    const stamped = await attempt(async () => ({
      status: "SUCCESS",
      envelopeXdr: attachEnvelope(),
    }));

    expect(update).toHaveBeenCalledTimes(1);
    expect(stamped.status).toBe("deployed");
    expect(record.deployment).toEqual({
      contractId: POLICY,
      txHash: "attach-tx",
      deployedAt: "2026-08-29T12:00:00.000Z",
    });
  });
});
