import {
  Account,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { HorizonAccount } from "./horizon";

// CleanupExecutor + MergePreflightValidator transaction building (idea.md
// §6.4; decisions.md option A): UNSIGNED classic transactions the user signs
// in the wallet that actually holds the old account's key. Hashes are
// precomputed (they don't change with signatures) so the wizard can watch
// Horizon and auto-advance.

/** Generous window: external signing can be slow. */
const TIMEOUT_SECONDS = 24 * 60 * 60;

/** Stellar's hard protocol limit: a transaction may carry at most 100
 * operations (a 101-op tx is rejected with txTOO_MANY_OPS). Cleanup batches
 * that exceed this are split into consecutive transactions. */
export const OPS_PER_TX = 100;

export interface CleanupStep {
  title: string;
  description: string;
  /** Unsigned transaction envelope, base64 XDR. */
  xdr: string;
  /** Network transaction hash (stable across signing) — watch Horizon for it. */
  hash: string;
}

function toAsset(code: string | undefined, issuer: string | undefined): Asset {
  if (!code || !issuer) throw new Error("Non-native asset is missing code or issuer");
  return new Asset(code, issuer);
}

function step(title: string, description: string, tx: Transaction): CleanupStep {
  return { title, description, xdr: tx.toXDR(), hash: tx.hash().toString("hex") };
}

/** A single cleanup operation plus the human-readable action it performs. */
interface CleanupOp {
  op: xdr.Operation;
  action: string;
}

/** Collects every cleanup operation in DEPENDENCY order (RA-5), each paired with
 * its description. The order matters for on-chain success:
 *   1. cancel offers  — an open sell offer locks the offered amount as a SELLING
 *      LIABILITY, so it is not spendable. Cancelling first frees it; otherwise a
 *      payment of the full balance below hits op_underfunded (only balance minus
 *      liabilities is movable) and the whole tx fails.
 *   2. pay out balances then remove each trustline — transfer before its removal.
 *   3. delete data entries.
 */
function collectCleanupOps(account: HorizonAccount, destination: string): CleanupOp[] {
  const out: CleanupOp[] = [];

  // 1. Cancel offers first — frees selling liabilities so the payments below can
  //    move the full asset balance.
  for (const offer of account.offers) {
    out.push({
      op: Operation.manageSellOffer({
        selling:
          offer.sellingAssetType === "native"
            ? Asset.native()
            : toAsset(offer.sellingAssetCode, offer.sellingAssetIssuer),
        buying:
          offer.buyingAssetType === "native"
            ? Asset.native()
            : toAsset(offer.buyingAssetCode, offer.buyingAssetIssuer),
        amount: "0",
        price: offer.price,
        offerId: offer.id,
      }),
      action: `cancel offer #${offer.id}`,
    });
  }

  // 2. Pay out each non-native balance, then remove its trustline.
  for (const balance of account.balances) {
    if (balance.assetType === "native") continue;
    const asset = toAsset(balance.assetCode, balance.assetIssuer);
    if (Number(balance.balance) > 0) {
      out.push({
        op: Operation.payment({ destination, asset, amount: balance.balance }),
        action: `send ${balance.balance} ${asset.getCode()} to the destination`,
      });
    }
    out.push({
      op: Operation.changeTrust({ asset, limit: "0" }),
      action: `remove the ${asset.getCode()} trustline`,
    });
  }

  // 3. Delete data entries.
  for (const key of account.dataKeys) {
    out.push({
      op: Operation.manageData({ name: key, value: null }),
      action: `delete data entry "${key}"`,
    });
  }

  return out;
}

/**
 * Builds the cleanup transaction(s): asset transfers to the destination,
 * trustline removals, offer cancellations, data deletions — in dependency
 * order. A batch that exceeds the 100-op protocol limit is split into
 * CONSECUTIVE transactions (each ≤ OPS_PER_TX) the user signs and submits in
 * order; the shared `Account` source auto-increments the sequence so tx N+1
 * follows tx N. Empty when there is nothing to clean.
 */
export function buildCleanupSteps(
  account: HorizonAccount,
  destination: string,
  networkPassphrase: string,
): CleanupStep[] {
  const cleanupOps = collectCleanupOps(account, destination);
  if (cleanupOps.length === 0) return [];

  // One shared source: each build() bumps its sequence, so the split
  // transactions carry consecutive sequence numbers.
  const source = new Account(account.accountId, account.sequence);
  const chunkCount = Math.ceil(cleanupOps.length / OPS_PER_TX);
  const steps: CleanupStep[] = [];

  for (let start = 0, part = 1; start < cleanupOps.length; start += OPS_PER_TX, part++) {
    const chunk = cleanupOps.slice(start, start + OPS_PER_TX);
    const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase });
    for (const { op } of chunk) builder.addOperation(op);
    const tx = builder.setTimeout(TIMEOUT_SECONDS).build();

    const actions = chunk.map((c) => c.action).join("; ");
    const title =
      chunkCount === 1 ? "Clean up the account" : `Clean up the account (${part}/${chunkCount})`;
    const description =
      (chunkCount === 1
        ? `One transaction that will: ${actions}.`
        : `Transaction ${part} of ${chunkCount} — sign and submit in order. This one will: ${actions}.`) +
      " Note: the destination must trust any asset being sent to it.";
    steps.push(step(title, description, tx));
  }

  return steps;
}

/** Builds the final account-merge transaction (call only when mergeReady). */
export function buildMergeStep(
  account: HorizonAccount,
  destination: string,
  networkPassphrase: string,
): CleanupStep {
  const source = new Account(account.accountId, account.sequence);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(TIMEOUT_SECONDS)
    .build();
  return step(
    "Merge and close the account",
    `Closes ${account.accountId} and sends its entire XLM balance to ${destination}. This cannot be undone.`,
    tx,
  );
}

/** Per-step confirmation state in a multi-step cleanup plan. */
export interface StepConfirmation {
  stepIndex: number;
  hash: string;
  confirmed: boolean;
  confirmedAt?: string;
}

/** Full tracking state for a multi-step cleanup plan. */
export interface MultiStepPlanTracking {
  planId: string;
  accountId: string;
  destination: string;
  totalSteps: number;
  steps: StepConfirmation[];
  originalSteps: CleanupStep[];
  expectedState: {
    sequence: string;
    balances: Array<{
      assetType: string;
      assetCode?: string;
      assetIssuer?: string;
      balance: string;
    }>;
    dataKeys: string[];
    openOffers: number;
  };
}

/** Creates a tracking record for a multi-step plan. */
export function createPlanTracking(
  account: HorizonAccount,
  destination: string,
  steps: CleanupStep[],
): MultiStepPlanTracking {
  return {
    planId: `plan_${account.accountId}_${Date.now()}`,
    accountId: account.accountId,
    destination,
    totalSteps: steps.length,
    steps: steps.map((s, idx) => ({
      stepIndex: idx,
      hash: s.hash,
      confirmed: false,
    })),
    originalSteps: steps,
    expectedState: {
      sequence: account.sequence,
      balances: account.balances.map((b) => ({ ...b })),
      dataKeys: [...account.dataKeys],
      openOffers: account.openOffers,
    },
  };
}

/** Records a step as confirmed by either step index or transaction hash. */
export function recordStepConfirmation(
  tracking: MultiStepPlanTracking,
  confirmedStepIndexOrHash: number | string,
): MultiStepPlanTracking {
  return {
    ...tracking,
    steps: tracking.steps.map((s) => {
      if (
        s.stepIndex === confirmedStepIndexOrHash ||
        s.hash === confirmedStepIndexOrHash
      ) {
        return {
          ...s,
          confirmed: true,
          confirmedAt: s.confirmedAt ?? new Date().toISOString(),
        };
      }
      return s;
    }),
  };
}

export interface ResumePlanOptions {
  currentAccount: HorizonAccount;
  destination: string;
  networkPassphrase: string;
  tracking: MultiStepPlanTracking;
}

export type ResumePlanResult =
  | {
      status: "resumed";
      resumedFromStep: number;
      remainingSteps: CleanupStep[];
      completedStepCount: number;
      totalSteps: number;
    }
  | {
      status: "completed";
      message: string;
    }
  | {
      status: "fresh_plan_required";
      reason: string;
      details?: Record<string, unknown>;
    };

/**
 * Resumes a partially completed multi-step cleanup plan from the last confirmed step.
 *
 * Verifies that confirmed steps executed in sequential order and validates that the on-chain
 * state has not diverged from expectations (e.g. unexpected trustline balance changes or new offers).
 * If on-chain state has changed since planning, safely refuses to resume and requires a fresh plan.
 */
export function resumeCleanupPlan(options: ResumePlanOptions): ResumePlanResult {
  const { currentAccount, destination, networkPassphrase, tracking } = options;

  if (currentAccount.accountId !== tracking.accountId) {
    return {
      status: "fresh_plan_required",
      reason: `Account mismatch: expected ${tracking.accountId} but received ${currentAccount.accountId}`,
    };
  }

  // Find confirmed step indices
  const confirmedIndices = tracking.steps
    .filter((s) => s.confirmed)
    .map((s) => s.stepIndex)
    .sort((a, b) => a - b);

  if (confirmedIndices.length === tracking.totalSteps) {
    return {
      status: "completed",
      message: "All steps in the cleanup plan have already been confirmed.",
    };
  }

  // Check that confirmed steps are contiguous starting from 0 (Stellar sequences require order)
  for (let i = 0; i < confirmedIndices.length; i++) {
    if (confirmedIndices[i] !== i) {
      return {
        status: "fresh_plan_required",
        reason: `Non-contiguous step confirmation: step ${i} is unconfirmed but subsequent step ${confirmedIndices[i]} is confirmed`,
      };
    }
  }

  const resumedFromStep = confirmedIndices.length;

  // Validate on-chain state against initial expected state.
  // Check 1: Check for unexpected new balances or changed balances on remaining assets
  const originalBalanceMap = new Map<string, string>();
  for (const b of tracking.expectedState.balances) {
    if (b.assetType === "native") continue;
    const key = `${b.assetCode}:${b.assetIssuer}`;
    originalBalanceMap.set(key, b.balance);
  }

  const currentBalanceMap = new Map<string, string>();
  for (const b of currentAccount.balances) {
    if (b.assetType === "native") continue;
    const key = `${b.assetCode}:${b.assetIssuer}`;
    currentBalanceMap.set(key, b.balance);
  }

  // Any brand new trustline balance that was never part of original plan requires a fresh plan
  for (const [key, curBal] of currentBalanceMap.entries()) {
    if (!originalBalanceMap.has(key)) {
      return {
        status: "fresh_plan_required",
        reason: `On-chain state changed: unexpected new asset trustline balance for ${key} (${curBal})`,
        details: { asset: key, currentBalance: curBal },
      };
    }
  }

  // Check if an existing trustline balance increased or changed unexpectedly
  for (const [key, curBal] of currentBalanceMap.entries()) {
    const origBal = originalBalanceMap.get(key);
    if (origBal !== undefined && curBal !== origBal && curBal !== "0") {
      // If balance changed to something other than being emptied, it requires a fresh plan
      return {
        status: "fresh_plan_required",
        reason: `On-chain state changed: trustline balance for ${key} changed from ${origBal} to ${curBal}`,
        details: { asset: key, previousBalance: origBal, currentBalance: curBal },
      };
    }
  }

  // Check 2: Check if new offers appeared that were not part of original plan
  if (currentAccount.openOffers > tracking.expectedState.openOffers) {
    return {
      status: "fresh_plan_required",
      reason: `On-chain state changed: open offers increased from ${tracking.expectedState.openOffers} to ${currentAccount.openOffers}`,
    };
  }

  // Rebuild remaining steps from currentAccount state
  const remainingSteps = buildCleanupSteps(currentAccount, destination, networkPassphrase);

  return {
    status: "resumed",
    resumedFromStep,
    remainingSteps,
    completedStepCount: resumedFromStep,
    // The remaining work is rebuilt from the account as it is now, so its step count can differ
    // from the original plan (a step may have grown past the op limit and split, or shrunk).
    // The total follows the rebuild instead of echoing the stale count.
    totalSteps: resumedFromStep + remainingSteps.length,
  };
}
