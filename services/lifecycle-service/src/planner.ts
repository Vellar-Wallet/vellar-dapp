import type { CleanupPlan } from "@vela/types";
import type { HorizonAccount } from "./horizon";

// CleanupPlanner (idea.md §6.4): turns inspected account state into the
// doc's CleanupPlan — every blocker explicit, merge only when none remain.
// Destructive flows are guided planners with user review, never one-click.

const CLASSIC_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export function isClassicAccountId(value: string): boolean {
  return CLASSIC_ACCOUNT_RE.test(value);
}

/** Operations fit ~100 to a transaction; the final merge is its own tx. */
const OPS_PER_TX = 100;

export function buildCleanupPlan(account: HorizonAccount, destination: string): CleanupPlan {
  const blockers: CleanupPlan["blockers"] = [];

  for (const balance of account.balances) {
    if (balance.assetType === "native") continue;
    const asset = `${balance.assetCode ?? "?"}:${balance.assetIssuer ?? "?"}`;
    if (Number(balance.balance) > 0) {
      blockers.push({
        type: "balance",
        description: `Holds ${balance.balance} ${balance.assetCode ?? asset}`,
        actionRequired: `Transfer or burn the ${balance.assetCode ?? asset} balance before removing its trustline`,
      });
    }
    blockers.push({
      type: "trustline",
      description: `Trustline to ${asset}`,
      actionRequired: `Remove the ${balance.assetCode ?? asset} trustline (requires zero balance)`,
    });
  }

  if (account.openOffers > 0) {
    blockers.push({
      type: "offer",
      description: `${account.openOffers} open DEX offer(s)`,
      actionRequired: "Cancel all open offers",
    });
  }

  for (const key of account.dataKeys) {
    blockers.push({
      type: "data",
      description: `Managed data entry "${key}"`,
      actionRequired: `Delete the "${key}" data entry`,
    });
  }

  // Cleanup ops (one per blocker except pure balance-transfer notes pair with
  // their trustline removal) + the final merge transaction.
  const cleanupOps = blockers.length;
  const estimatedTransactions = Math.max(1, Math.ceil(cleanupOps / OPS_PER_TX) + 1);

  return {
    accountId: account.accountId,
    destination,
    blockers,
    estimatedTransactions: blockers.length === 0 ? 1 : estimatedTransactions,
    mergeReady: blockers.length === 0,
  };
}
