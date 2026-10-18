import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERIC_TRANSIENT_BACKOFF,
  DEFAULT_REGISTRY_TRANSIENT_BACKOFF,
  classifyRegistrySubmissionError,
  computeBackoffDelayMs,
  createRegistrySubmitter,
  type RegistryRetryEvent,
  type RegistrySubmitterOptions,
} from "./registry-submitter";

const REGISTRY_CONTRACT_ID = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const TARGET_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const WASM_HASH_HEX = "a".repeat(64);

describe("Registry Submitter Error Classification & Backoff (#539)", () => {
  it("classifies registry-specific transient errors distinctly from generic transient and terminal errors", () => {
    // Registry-specific transient errors
    expect(classifyRegistrySubmissionError(new Error("txBAD_SEQ"))).toBe("registry_transient");
    expect(
      classifyRegistrySubmissionError(
        new Error('registry upsert submission rejected: {"code":"txBAD_SEQ"}'),
      ),
    ).toBe("registry_transient");
    expect(classifyRegistrySubmissionError(new Error("sequence number mismatch"))).toBe(
      "registry_transient",
    );
    expect(classifyRegistrySubmissionError(new Error("TRY_AGAIN_LATER"))).toBe(
      "registry_transient",
    );
    expect(classifyRegistrySubmissionError(new Error("temporary_lock on registry entry"))).toBe(
      "registry_transient",
    );

    // Generic network / RPC transient errors
    expect(classifyRegistrySubmissionError(new Error("read ECONNRESET"))).toBe("generic_transient");
    expect(classifyRegistrySubmissionError(new Error("connect ETIMEDOUT"))).toBe(
      "generic_transient",
    );
    expect(classifyRegistrySubmissionError(new Error("RPC HTTP 503 Service Unavailable"))).toBe(
      "generic_transient",
    );
    expect(
      classifyRegistrySubmissionError(new Error("registry upsert not final after 30s (tx abc)")),
    ).toBe("generic_transient");

    // Terminal errors
    expect(
      classifyRegistrySubmissionError(
        new Error('registry upsert submission rejected: {"code":"txBAD_AUTH"}'),
      ),
    ).toBe("terminal");
    expect(
      classifyRegistrySubmissionError(new Error("registry upsert failed on-chain (tx abc)")),
    ).toBe("terminal");
  });

  it("applies a faster backoff schedule for registry_transient than generic_transient", () => {
    const reg1 = computeBackoffDelayMs("registry_transient", 1);
    const reg2 = computeBackoffDelayMs("registry_transient", 2);
    const gen1 = computeBackoffDelayMs("generic_transient", 1);
    const gen2 = computeBackoffDelayMs("generic_transient", 2);

    expect(reg1).toBe(DEFAULT_REGISTRY_TRANSIENT_BACKOFF.initialDelayMs);
    expect(gen1).toBe(DEFAULT_GENERIC_TRANSIENT_BACKOFF.initialDelayMs);
    expect(reg1).toBeLessThan(gen1);
    expect(reg2).toBeLessThan(gen2);
  });

  it("resolves a simulated sequence-number conflict (txBAD_SEQ) on the next retry by re-fetching the account sequence", async () => {
    const attestorKeypair = Keypair.random();
    const accountSequencesFetched: string[] = [];
    const submittedSequences: string[] = [];
    const retryEvents: RegistryRetryEvent[] = [];
    const sleepDurations: number[] = [];

    let currentAccountSeq = 100n;
    let sendCalls = 0;

    const fakeServer: NonNullable<RegistrySubmitterOptions["server"]> = {
      getAccount: async (publicKey: string) => {
        const seqStr = currentAccountSeq.toString();
        accountSequencesFetched.push(seqStr);
        return new Account(publicKey, seqStr);
      },
      prepareTransaction: async (tx) => tx,
      sendTransaction: async (tx) => {
        sendCalls += 1;
        submittedSequences.push(tx.sequence);
        if (sendCalls === 1) {
          // Simulate concurrent writer advancing the account sequence on-chain
          currentAccountSeq = 105n;
          return {
            status: "ERROR",
            errorResult: { code: "txBAD_SEQ", detail: "sequence number mismatch" },
          } as unknown as Awaited<
            ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["sendTransaction"]>
          >;
        }
        return {
          status: "PENDING",
          hash: "tx-hash-after-seq-refetch",
        } as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["sendTransaction"]>
        >;
      },
      getTransaction: async () =>
        ({
          status: "SUCCESS",
        }) as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["getTransaction"]>
        >,
      simulateTransaction: async () =>
        ({}) as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["simulateTransaction"]>
        >,
      getLatestLedger: async () => ({ id: "ledger-1", protocolVersion: 21, sequence: 1000 }),
    };

    const submitter = createRegistrySubmitter({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
      registryContractId: REGISTRY_CONTRACT_ID,
      attestorSecretKey: attestorKeypair.secret(),
      server: fakeServer,
      sleep: async (ms) => {
        sleepDurations.push(ms);
      },
      onRetry: (event) => {
        retryEvents.push(event);
      },
    });

    await submitter.upsert(TARGET_CONTRACT_ID, WASM_HASH_HEX, 2000);

    expect(sendCalls).toBe(2);
    // First attempt built from sequence 100 (tx sequence 101); second attempt re-fetched 105 (tx sequence 106)
    expect(accountSequencesFetched).toEqual(["100", "105"]);
    expect(submittedSequences).toEqual(["101", "106"]);
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      method: "upsert",
      attempt: 1,
      errorClass: "registry_transient",
      delayMs: DEFAULT_REGISTRY_TRANSIENT_BACKOFF.initialDelayMs,
    });
    expect(sleepDurations).toEqual([DEFAULT_REGISTRY_TRANSIENT_BACKOFF.initialDelayMs]);
  });

  it("uses the generic_transient backoff schedule for RPC network errors and does not retry terminal errors", async () => {
    const attestorKeypair = Keypair.random();
    const retryEvents: RegistryRetryEvent[] = [];
    let attempt = 0;

    const fakeServer: NonNullable<RegistrySubmitterOptions["server"]> = {
      getAccount: async (publicKey: string) => new Account(publicKey, "200"),
      prepareTransaction: async (tx) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("fetch failed: read ECONNRESET");
        }
        return tx;
      },
      sendTransaction: async () =>
        ({
          status: "ERROR",
          errorResult: { code: "txBAD_AUTH" },
        }) as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["sendTransaction"]>
        >,
      getTransaction: async () =>
        ({
          status: "SUCCESS",
        }) as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["getTransaction"]>
        >,
      simulateTransaction: async () =>
        ({}) as unknown as Awaited<
          ReturnType<NonNullable<RegistrySubmitterOptions["server"]>["simulateTransaction"]>
        >,
      getLatestLedger: async () => ({ id: "ledger-1", protocolVersion: 21, sequence: 1000 }),
    };

    const submitter = createRegistrySubmitter({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
      registryContractId: REGISTRY_CONTRACT_ID,
      attestorSecretKey: attestorKeypair.secret(),
      server: fakeServer,
      sleep: async () => {},
      onRetry: (event) => {
        retryEvents.push(event);
      },
    });

    await expect(submitter.revoke(TARGET_CONTRACT_ID)).rejects.toThrow(/txBAD_AUTH/);

    // Retried once for ECONNRESET (generic_transient), then failed immediately on txBAD_AUTH (terminal)
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      method: "revoke",
      attempt: 1,
      errorClass: "generic_transient",
      delayMs: DEFAULT_GENERIC_TRANSIENT_BACKOFF.initialDelayMs,
    });
  });
});
