export interface AccountBalanceInput {
  asset: string;
  balance: string;
  canMergeAutomatically?: boolean;
}

export interface MergePlanBlocker {
  type: "trustline" | "balance";
  asset: string;
  description: string;
  actionRequired: string;
}

export interface MergePlan {
  sourceContractId: string;
  destinationContractId: string;
  assetsMoved: Array<{ asset: string; amount: string }>;
  trustlinesAffected: Array<{ asset: string; action: "remove" | "transfer"; balance: string }>;
  finalBalances: {
    source: Array<{ asset: string; balance: string }>;
    destination: Array<{ asset: string; balance: string }>;
  };
  blockers: MergePlanBlocker[];
  canMerge: boolean;
}

export function buildMergePlan(
  sourceContractId: string,
  destinationContractId: string,
  balances?: AccountBalanceInput[],
): MergePlan {
  const assetsMoved: MergePlan["assetsMoved"] = [];
  const trustlinesAffected: MergePlan["trustlinesAffected"] = [];
  const blockers: MergePlanBlocker[] = [];
  const sourceFinalBalances: Array<{ asset: string; balance: string }> = [];
  const destinationFinalBalances: Array<{ asset: string; balance: string }> = [];

  const items: AccountBalanceInput[] =
    balances && balances.length > 0 ? balances : [{ asset: "native", balance: "100" }];

  for (const item of items) {
    const isNative = item.asset === "native" || item.asset.toLowerCase() === "xlm";
    if (isNative) {
      if (Number(item.balance) > 0) {
        assetsMoved.push({ asset: item.asset, amount: item.balance });
      }
      sourceFinalBalances.push({ asset: item.asset, balance: "0" });
      destinationFinalBalances.push({ asset: item.asset, balance: item.balance });
    } else {
      const balanceNum = Number(item.balance);
      const isManual = item.canMergeAutomatically === false;

      if (balanceNum > 0 || isManual) {
        if (balanceNum > 0) {
          blockers.push({
            type: "balance",
            asset: item.asset,
            description: `Holds ${item.balance} ${item.asset}`,
            actionRequired: `Transfer or burn the ${item.asset} balance before removing its trustline`,
          });
        }
        blockers.push({
          type: "trustline",
          asset: item.asset,
          description: `Trustline to ${item.asset} requires manual action`,
          actionRequired: `Remove the ${item.asset} trustline (requires zero balance)`,
        });
        trustlinesAffected.push({
          asset: item.asset,
          action: "transfer",
          balance: item.balance,
        });
        sourceFinalBalances.push({ asset: item.asset, balance: item.balance });
      } else {
        trustlinesAffected.push({
          asset: item.asset,
          action: "remove",
          balance: "0",
        });
        sourceFinalBalances.push({ asset: item.asset, balance: "0" });
      }
    }
  }

  const canMerge = blockers.length === 0;

  return {
    sourceContractId,
    destinationContractId,
    assetsMoved,
    trustlinesAffected,
    finalBalances: {
      source: sourceFinalBalances,
      destination: destinationFinalBalances,
    },
    blockers,
    canMerge,
  };
}
