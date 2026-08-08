import {
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import type { SpendBudget, BudgetNetwork } from "@vellar/service-kit";
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
  /** Hard reject any tx whose simulation-derived fee exceeds this (stroops).
   * Defaults to SPONSOR_DEFAULT_MAX_FEE_STROOPS. Bounds per-call sponsor loss
   * (security-audit.md C1/H1): a genuine wallet op assesses well under 0.1 XLM;
   * anything higher is anomalous and is not auto-sponsored. */
  maxFeeStroops?: string;
  /** Rolling-window spend budget for the "sponsor" line (FIX 3). Consumed with
   * the real simulation-derived fee AFTER prepareTransaction and BEFORE signing,
   * so a budget refusal costs only a (free) simulation. Fails closed. */
  budget?: SpendBudget;
  /** Network label for budget accounting — from server config, never a request
   * body (V5). Required when budget is set. */
  budgetNetwork?: BudgetNetwork;
}

// Default per-call sponsor fee cap: 0.1 XLM. Replaces the old hardcoded
// 10,000,000-stroop (1 XLM) inclusion-fee ceiling — a 10x reduction. The bid is
// still simulation-derived (prepareTransaction sets the real fee); this is the
// safety cap above which we refuse to pay. Override via SPONSOR_MAX_FEE_STROOPS.
export const SPONSOR_DEFAULT_MAX_FEE_STROOPS = "1000000";

/** Throws SubmissionError("sponsor_fee_too_high") when the simulation-derived
 * fee exceeds the cap. Pure so it can be unit-tested without a live RPC. */
export function enforceFeeCap(feeStroops: string, maxStroops: string): void {
  if (BigInt(feeStroops) > BigInt(maxStroops)) {
    throw new SubmissionError(
      `Sponsor fee ${feeStroops} stroops exceeds the ${maxStroops}-stroop cap; refusing to sponsor.`,
      "sponsor_fee_too_high",
    );
  }
}

/** Consume the sponsor budget line for a fee, or throw
 * SubmissionError("sponsor_budget_exceeded"). No-op when no budget is wired.
 * FAILS CLOSED: a refusal OR an accounting error blocks the submission. Pure of
 * RPC so it is unit-testable. */
export async function consumeSponsorBudget(
  feeStroops: string,
  budget: SpendBudget | undefined,
  network: BudgetNetwork | undefined,
): Promise<void> {
  if (!budget || !network) return;
  let allowed: boolean;
  try {
    const r = await budget.tryConsume({ line: "sponsor", network, stroops: BigInt(feeStroops) });
    allowed = r.ok;
  } catch {
    allowed = false; // fail closed
  }
  if (!allowed) {
    throw new SubmissionError("Sponsor spend budget reached; try again later.", "sponsor_budget_exceeded");
  }
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
  const maxFeeStroops = config.maxFeeStroops ?? SPONSOR_DEFAULT_MAX_FEE_STROOPS;
  // Ceiling the pre-simulation bid at the cap too, so the builder can never
  // offer more than we're willing to pay even before prepareTransaction runs.
  const bidCeiling = maxFeeStroops;

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
        fee: bidCeiling,
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

      // prepareTransaction sets the true simulation-derived fee. Refuse to
      // sponsor anything over the cap (security-audit.md C1/H1).
      enforceFeeCap(prepared.fee, maxFeeStroops);

      // Consume the rolling-window sponsor budget with the REAL fee, before
      // signing/submitting (FIX 3). Fails closed.
      await consumeSponsorBudget(prepared.fee, config.budget, config.budgetNetwork);

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
