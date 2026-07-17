import {
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { SubmissionError, type TransactionSubmitter } from "./relayer";

// Direct-RPC fee sponsorship (docs/decisions.md 2026-07-16 P27-V2 finding):
// passkey-kit v0.14 signs address-bound V2 credentials (CAP-0071-02), which
// the OpenZeppelin relayer's parser rejects. For Soroban invocations with
// address-credential auth we rebuild the envelope around {func, auth} with
// our own funded sponsor account — the same thing the relayer does server-
// side — and submit via RPC. Everything else stays on the relayer.

export interface SponsorConfig {
  rpcUrl: string;
  networkPassphrase: string;
  secretKey: string;
}

/** True when the tx is a Soroban invocation authorized by address credentials
 * (the shape the relayer's V2-unaware parser rejects). */
export function needsSponsorRebuild(signedXdr: string, networkPassphrase: string): boolean {
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return false;
  }
  if (!("operations" in tx) || tx.operations.length !== 1) return false;
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction" || !op.auth || op.auth.length === 0) return false;
  return op.auth.every(
    (entry) => entry.credentials().switch().name !== "sorobanCredentialsSourceAccount",
  );
}

export function createSponsorSubmitter(config: SponsorConfig): TransactionSubmitter {
  const server = new rpc.Server(config.rpcUrl);
  const sponsor = Keypair.fromSecret(config.secretKey);

  return {
    async submit(signedXdr) {
      const inner = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase) as Transaction;
      const op = inner.operations[0];
      if (op?.type !== "invokeHostFunction") {
        throw new SubmissionError(
          "Sponsor path requires an invokeHostFunction tx",
          "sponsor_bad_tx",
        );
      }

      // Rebuild around the signed auth entries with the sponsor as fee source.
      const account = await server.getAccount(sponsor.publicKey());
      const rebuilt = new TransactionBuilder(account, {
        fee: "10000000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: op.func,
            auth: op.auth as xdr.SorobanAuthorizationEntry[],
          }),
        )
        .setTimeout(60)
        .build();

      let prepared: Transaction;
      try {
        prepared = (await server.prepareTransaction(rebuilt)) as Transaction;
      } catch (err) {
        throw new SubmissionError(
          `Sponsor simulation failed: ${err instanceof Error ? err.message : String(err)}`,
          "sponsor_simulation_failed",
        );
      }
      prepared.sign(sponsor);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new SubmissionError(
          `Sponsor submission failed: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
          "sponsor_submit_failed",
        );
      }

      const deadline = Date.now() + 60_000;
      for (;;) {
        const status = await server.getTransaction(sent.hash);
        if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash };
        if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new SubmissionError(`Transaction failed on-chain: ${sent.hash}`, "tx_failed");
        }
        if (Date.now() > deadline) {
          throw new SubmissionError(`Transaction still pending: ${sent.hash}`, "tx_timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  };
}

/** Routes address-auth Soroban txs to the sponsor, everything else to the fallback. */
export function createHybridSubmitter(
  sponsor: TransactionSubmitter,
  fallback: TransactionSubmitter,
  networkPassphrase: string,
): TransactionSubmitter {
  return {
    async submit(signedXdr) {
      if (needsSponsorRebuild(signedXdr, networkPassphrase)) {
        return sponsor.submit(signedXdr);
      }
      return fallback.submit(signedXdr);
    },
  };
}
