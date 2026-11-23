import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, xdr } from "@stellar/stellar-sdk";
import { ThresholdKeyManager, createThresholdSubmitter } from "./threshold-submitter";

/**
 * #687: a signer is revoked from the threshold set at the exact moment a submission reaches its
 * M-of-N quorum. The quorum counted a moment ago must never be what lands: the submission either
 * signs again against the current signer set, or it is refused, or the chain rejects it. In
 * every case the caller sees an error rather than a success, and no stale quorum is retried.
 *
 * A revocation is simulated by removing the signer from the key manager while the submission is
 * between steps (the awaited RPC calls), which is the window the race lives in.
 */

const NETWORK = "Test SDF Network ; September 2015";
const REGISTRY = "CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP";
const ATTESTOR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TARGET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const WASM = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function setup(signerCount: number, opts: { attest: number; revoke?: number }) {
  const relayer = Keypair.random();
  const keys = Array.from({ length: signerCount }, () => Keypair.random());
  const manager = new ThresholdKeyManager(keys.map((k) => k.secret()));
  const server = {
    getAccount: vi.fn().mockResolvedValue(new Account(relayer.publicKey(), "100")),
    prepareTransaction: vi.fn().mockImplementation(async (tx) => tx),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "tx_687" }),
    getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: xdr.ScVal.scvVoid() } }),
  };
  const submitter = createThresholdSubmitter({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: NETWORK,
    registryContractId: REGISTRY,
    thresholdAttestorContractId: ATTESTOR,
    relayerSecretKey: relayer.secret(),
    keyManager: manager,
    attestThreshold: opts.attest,
    revokeThreshold: opts.revoke,
    server,
  });
  return { submitter, server, manager, keys };
}

/** Removes the signer at `index` from the live signer set, as a revocation landing would. */
function revokeSigner(manager: ThresholdKeyManager, index: number) {
  const internal = manager as unknown as { signers: Array<{ index: number }> };
  const at = internal.signers.findIndex((s) => s.index === index);
  expect(at).toBeGreaterThanOrEqual(0);
  internal.signers.splice(at, 1);
}

/** Signer indices carried by the auth entry of the transaction handed to sendTransaction. */
function signedIndices(server: ReturnType<typeof setup>["server"], call = 0): number[] {
  const tx = server.sendTransaction.mock.calls[call]![0];
  const creds = (tx.operations[0] as any).auth[0].credentials().address();
  const entry = creds
    .signature()
    .map()!
    .find((e: any) => e.key().sym().toString() === "signatures");
  return entry!
    .val()
    .vec()!
    .map((s: any) =>
      s
        .map()
        .find((e: any) => e.key().sym().toString() === "signer_index")
        .val()
        .u32(),
    );
}

describe("exactly M of N approve", () => {
  it("carries exactly M signatures, ascending, from the first M signers", async () => {
    const { submitter, server } = setup(5, { attest: 3 });

    await submitter.upsert(TARGET, WASM, 6000);

    expect(signedIndices(server)).toEqual([0, 1, 2]);
  });

  it("works when M equals N", async () => {
    const { submitter, server } = setup(3, { attest: 3 });

    await submitter.upsert(TARGET, WASM, 6000);

    expect(signedIndices(server)).toEqual([0, 1, 2]);
  });
});

describe("a signer is revoked while the submission is reaching quorum", () => {
  it("does not include the revoked signer, even when it was the deciding (Mth) one", async () => {
    const { submitter, server, manager } = setup(3, { attest: 2 });
    // The Mth signature of a 2-of-3 comes from signer index 1. Revoke it right before signing.
    server.getLatestLedger.mockImplementation(async () => {
      revokeSigner(manager, 1);
      return { sequence: 5000 };
    });

    await submitter.upsert(TARGET, WASM, 6000);

    const indices = signedIndices(server);
    expect(indices).toHaveLength(2);
    expect(indices).not.toContain(1);
    expect(indices).toEqual([0, 2]);
  });

  it("includes that same signer when nothing is revoked (control)", async () => {
    const { submitter, server } = setup(3, { attest: 2 });

    await submitter.upsert(TARGET, WASM, 6000);

    expect(signedIndices(server)).toContain(1);
  });

  it("refuses, and sends nothing, when the revocation leaves fewer than M signers", async () => {
    const { submitter, server, manager } = setup(2, { attest: 2 });
    server.getLatestLedger.mockImplementation(async () => {
      revokeSigner(manager, 1);
      return { sequence: 5000 };
    });

    await expect(submitter.upsert(TARGET, WASM, 6000)).rejects.toThrow(
      /Cannot produce 2 signatures with only 1 configured signers/,
    );

    expect(server.prepareTransaction).not.toHaveBeenCalled();
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(server.getTransaction).not.toHaveBeenCalled();
  });

  it("applies the same refusal to the fast-path revoke when its only signer is revoked", async () => {
    const { submitter, server, manager } = setup(1, { attest: 1, revoke: 1 });
    server.getLatestLedger.mockImplementation(async () => {
      revokeSigner(manager, 0);
      return { sequence: 5000 };
    });

    await expect(submitter.revoke(TARGET)).rejects.toThrow(/only 0 configured signers/);

    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("judges each submission by the signer set at its own signing time", async () => {
    const { submitter, server, manager } = setup(3, { attest: 2 });

    await submitter.upsert(TARGET, WASM, 6000);
    revokeSigner(manager, 1);
    await submitter.upsert(TARGET, WASM, 6001);

    expect(signedIndices(server, 0)).toEqual([0, 1]);
    expect(signedIndices(server, 1)).toEqual([0, 2]);
  });

  it("does not let a failed refusal poison the next submission once enough signers are back", async () => {
    const { submitter, server, manager } = setup(2, { attest: 2 });
    const revoked = (manager as unknown as { signers: unknown[] }).signers[1];
    server.getLatestLedger.mockImplementationOnce(async () => {
      revokeSigner(manager, 1);
      return { sequence: 5000 };
    });
    await expect(submitter.upsert(TARGET, WASM, 6000)).rejects.toThrow(/Cannot produce 2/);

    (manager as unknown as { signers: unknown[] }).signers.push(revoked); // reinstated
    await submitter.upsert(TARGET, WASM, 6001);

    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(signedIndices(server)).toEqual([0, 1]);
  });
});

describe("a signer is revoked after the quorum was signed, before the transaction lands", () => {
  it("surfaces a rejection at submission as an error, once, without retrying the stale quorum", async () => {
    const { submitter, server } = setup(3, { attest: 2 });
    server.sendTransaction.mockResolvedValue({
      status: "ERROR",
      errorResult: "txFAILED: signer revoked",
    });

    await expect(submitter.upsert(TARGET, WASM, 6000)).rejects.toThrow(
      /threshold registry upsert submission rejected/,
    );

    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(server.getTransaction).not.toHaveBeenCalled();
  });

  it("surfaces an on-chain failure naming the transaction, and never reports success", async () => {
    const { submitter, server } = setup(3, { attest: 2 });
    server.getTransaction.mockResolvedValue({ status: "FAILED" });

    await expect(submitter.upsert(TARGET, WASM, 6000)).rejects.toThrow(
      /threshold registry upsert failed on-chain \(tx tx_687\)/,
    );

    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports no revocation latency for a revoke that failed on-chain", async () => {
    const { submitter, server } = setup(3, { attest: 2, revoke: 2 });
    server.getTransaction.mockResolvedValue({ status: "FAILED" });

    await expect(submitter.measureRevocationLatencyMs(TARGET)).rejects.toThrow(
      /revoke failed on-chain/,
    );
  });

  it("stops before sending when preparing the transaction fails because the auth no longer verifies", async () => {
    const { submitter, server } = setup(3, { attest: 2 });
    server.prepareTransaction.mockRejectedValue(new Error("simulation failed: signer not in set"));

    await expect(submitter.upsert(TARGET, WASM, 6000)).rejects.toThrow(/signer not in set/);

    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("waits through a pending result and succeeds when the chain accepts the quorum", async () => {
    const { submitter, server } = setup(3, { attest: 2 });
    server.getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS" });

    await expect(submitter.upsert(TARGET, WASM, 6000)).resolves.toBeUndefined();

    expect(server.getTransaction).toHaveBeenCalledTimes(2);
  });
});
