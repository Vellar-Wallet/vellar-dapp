import { StrKey } from "@stellar/stellar-sdk";
import type { CleanupPlan } from "@vellar/types";
import { assertCompleteAccountPagination, type HorizonAccount } from "./horizon";

// CleanupPlanner (idea.md §6.4): turns inspected account state into the
// doc's CleanupPlan — every blocker explicit, merge only when none remain.
// Destructive flows are guided planners with user review, never one-click.

// Full StrKey check (version byte + checksum), not just the shape: a
// well-shaped but invalid G… address would otherwise pass here and throw later
// inside the transaction builder as a 500.
export function isClassicAccountId(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** Operations fit ~100 to a transaction; the final merge is its own tx. */
const OPS_PER_TX = 100;

export function buildCleanupPlan(account: HorizonAccount, destination: string): CleanupPlan {
  assertCompleteAccountPagination(account);
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

  // The estimate must track the ACTUAL operation count the builder emits, not
  // blocker count: a "N open offers" blocker is one row but N cancel ops, and a
  // non-zero balance is two ops (transfer + trustline removal). Undercounting
  // here would promise fewer transactions than the split builder produces.
  let cleanupOps = 0;
  for (const balance of account.balances) {
    if (balance.assetType === "native") continue;
    if (Number(balance.balance) > 0) cleanupOps++; // payment
    cleanupOps++; // trustline removal
  }
  cleanupOps += account.openOffers; // one manageSellOffer per open offer
  cleanupOps += account.dataKeys.length; // one manageData per entry
  const estimatedTransactions = Math.max(1, Math.ceil(cleanupOps / OPS_PER_TX) + 1);

  return {
    accountId: account.accountId,
    destination,
    blockers,
    estimatedTransactions: blockers.length === 0 ? 1 : estimatedTransactions,
    mergeReady: blockers.length === 0,
  };
}
