import {
  Account,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { HorizonAccount } from "./horizon";

// CleanupExecutor + MergePreflightValidator transaction building (idea.md
// §6.4; decisions.md option A): UNSIGNED classic transactions the user signs
// in the wallet that actually holds the old account's key. Hashes are
// precomputed (they don't change with signatures) so the wizard can watch
// Horizon and auto-advance.

/** Generous window: external signing can be slow. */
const TIMEOUT_SECONDS = 24 * 60 * 60;

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

/**
 * Builds the cleanup transaction(s): asset transfers to the destination,
 * trustline removals, offer cancellations, data deletions — in dependency
 * order, batched into one transaction (accounts needing >100 ops can re-run
 * the wizard). Empty when there is nothing to clean.
 */
export function buildCleanupSteps(
  account: HorizonAccount,
  destination: string,
  networkPassphrase: string,
): CleanupStep[] {
  const source = new Account(account.accountId, account.sequence);
  const actions: string[] = [];
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase });
  let ops = 0;

  for (const balance of account.balances) {
    if (balance.assetType === "native") continue;
    const asset = toAsset(balance.assetCode, balance.assetIssuer);
    if (Number(balance.balance) > 0) {
      builder.addOperation(Operation.payment({ destination, asset, amount: balance.balance }));
      actions.push(`send ${balance.balance} ${asset.getCode()} to the destination`);
      ops++;
    }
    builder.addOperation(Operation.changeTrust({ asset, limit: "0" }));
    actions.push(`remove the ${asset.getCode()} trustline`);
    ops++;
  }

  for (const offer of account.offers) {
    builder.addOperation(
      Operation.manageSellOffer({
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
    );
    actions.push(`cancel offer #${offer.id}`);
    ops++;
  }

  for (const key of account.dataKeys) {
    builder.addOperation(Operation.manageData({ name: key, value: null }));
    actions.push(`delete data entry "${key}"`);
    ops++;
  }

  if (ops === 0) return [];

  const tx = builder.setTimeout(TIMEOUT_SECONDS).build();
  return [
    step(
      "Clean up the account",
      `One transaction that will: ${actions.join("; ")}. Note: the destination must trust any asset being sent to it.`,
      tx,
    ),
  ];
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
