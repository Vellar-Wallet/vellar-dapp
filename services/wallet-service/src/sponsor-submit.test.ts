import { Keypair } from "@stellar/stellar-sdk";
import type { SpendBudget } from "@vellar/service-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryReplayGuard } from "./replay";
import { SubmissionError, type TransactionSubmitter } from "./relayer";
import { buildServer } from "./server";
import { createMemoryWalletRepository } from "./repository";
import { createHybridSubmitter, createSponsorSubmitter } from "./sponsor";
import { buildInvokeTx, KNOWN_WALLET, PASSPHRASE } from "./test-fixtures";

// The real sponsor submitter against a fake RPC server: what it does with each
// sendTransaction status, and that a replayed signed tx consumes the sponsor
// budget exactly once end to end (route reservation -> hybrid -> sponsor).

const rpcControl = vi.hoisted(() => ({
  sendStatus: "PENDING" as string,
  sendCalls: 0,
  getTransactionCalls: 0,
  sendDelay: Promise.resolve() as Promise<void>,
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    async getAccount(publicKey: string) {
      return new actual.Account(publicKey, "100");
    }
    async prepareTransaction(tx: unknown) {
      return tx; // fee stays at the builder's bid ceiling
    }
    async sendTransaction() {
      rpcControl.sendCalls += 1;
      await rpcControl.sendDelay;
      if (rpcControl.sendStatus === "ERROR") {
        return { status: "ERROR", hash: "errhash", errorResult: undefined };
      }
      return { status: rpcControl.sendStatus, hash: "sponsorhash" };
    }
    async getTransaction() {
      rpcControl.getTransactionCalls += 1;
      return { status: actual.rpc.Api.GetTransactionStatus.SUCCESS };
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } };
});

function sponsor(budget?: SpendBudget) {
  return createSponsorSubmitter({
    rpcUrl: "http://rpc.invalid",
    networkPassphrase: PASSPHRASE,
    secretKey: Keypair.random().secret(),
    budget,
    budgetNetwork: budget ? "testnet" : undefined,
  });
}

beforeEach(() => {
  rpcControl.sendStatus = "PENDING";
  rpcControl.sendCalls = 0;
  rpcControl.getTransactionCalls = 0;
  rpcControl.sendDelay = Promise.resolve();
});

describe("createSponsorSubmitter: sendTransaction status handling", () => {
  const signed = () => buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "1", expiration: 9 }]);

  it("PENDING then SUCCESS resolves with the hash", async () => {
    await expect(sponsor().submit(signed())).resolves.toEqual({ hash: "sponsorhash" });
  });

  it("DUPLICATE (already in the pool) is polled to completion, not treated as a failure", async () => {
    rpcControl.sendStatus = "DUPLICATE";
    await expect(sponsor().submit(signed())).resolves.toEqual({ hash: "sponsorhash" });
    expect(rpcControl.getTransactionCalls).toBeGreaterThan(0);
  });

  it("TRY_AGAIN_LATER is a definite not-accepted: coded error, and it does NOT poll a hash that never entered the pool", async () => {
    rpcControl.sendStatus = "TRY_AGAIN_LATER";

    const err = await sponsor()
      .submit(signed())
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe("sponsor_try_again_later");
    expect(rpcControl.getTransactionCalls).toBe(0);
  });

  it("ERROR is a rejection before inclusion: coded sponsor_submit_failed", async () => {
    rpcControl.sendStatus = "ERROR";
    await expect(sponsor().submit(signed())).rejects.toMatchObject({
      code: "sponsor_submit_failed",
    });
    expect(rpcControl.getTransactionCalls).toBe(0);
  });
});

describe("replay through the real sponsor path: the budget is consumed exactly once", () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function budgetSpy() {
    const tryConsume = vi.fn(async () => ({ ok: true as const }));
    return { budget: { tryConsume } as unknown as SpendBudget, tryConsume };
  }

  async function serverWith(submitter: TransactionSubmitter) {
    const wallets = createMemoryWalletRepository();
    await wallets.insert({
      keyId: "k",
      contractId: KNOWN_WALLET,
      network: "testnet",
      createdAt: new Date().toISOString(),
    });
    app = buildServer({
      submitter,
      wallets,
      networkPassphrase: PASSPHRASE,
      replayGuard: createMemoryReplayGuard(),
      getLatestLedger: async () => 1,
    });
    return app;
  }

  const post = (server: NonNullable<typeof app>, signedXdr: string) =>
    server.inject({
      method: "POST",
      url: "/wallet/submit",
      payload: { signedXdr, network: "testnet" },
    });

  it("the same signed tx twice in sequence spends budget once", async () => {
    const { budget, tryConsume } = budgetSpy();
    const relayer: TransactionSubmitter = { submit: vi.fn() };
    const server = await serverWith(createHybridSubmitter(sponsor(budget), relayer, PASSPHRASE));
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "5", expiration: 9 }]);

    expect((await post(server, signed)).statusCode).toBe(200);
    expect((await post(server, signed)).statusCode).toBe(409);

    expect(tryConsume).toHaveBeenCalledTimes(1);
    expect(rpcControl.sendCalls).toBe(1);
    expect(relayer.submit).not.toHaveBeenCalled();
  });

  it("many concurrent copies (some re-wrapped) spend budget once and send once", async () => {
    const { budget, tryConsume } = budgetSpy();
    let open!: () => void;
    rpcControl.sendDelay = new Promise<void>((resolve) => (open = resolve));
    const relayer: TransactionSubmitter = { submit: vi.fn() };
    const server = await serverWith(createHybridSubmitter(sponsor(budget), relayer, PASSPHRASE));
    // Different random envelopes, identical (address, nonce): all are replays.
    const copies = Array.from({ length: 6 }, () =>
      buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "6", expiration: 9 }]),
    );

    const inFlight = copies.map((c) => post(server, c));
    await vi.waitFor(() => expect(rpcControl.sendCalls).toBe(1));
    open();
    const results = await Promise.all(inFlight);

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(tryConsume).toHaveBeenCalledTimes(1);
    expect(rpcControl.sendCalls).toBe(1);
  });

  it("a TRY_AGAIN_LATER releases the reservation, so the legitimate retry is not refused", async () => {
    const { budget } = budgetSpy();
    const server = await serverWith(
      createHybridSubmitter(sponsor(budget), { submit: vi.fn() }, PASSPHRASE),
    );
    const signed = buildInvokeTx([{ subject: KNOWN_WALLET, nonce: "7", expiration: 9 }]);

    rpcControl.sendStatus = "TRY_AGAIN_LATER";
    expect((await post(server, signed)).statusCode).toBe(502);

    rpcControl.sendStatus = "PENDING";
    expect((await post(server, signed)).statusCode).toBe(200);
  });
});
