import type { Network } from "@vellar/types";

// Explorer links (issue #403: "Each row links to a working explorer entry for
// the tx hash"). stellar.expert serves both networks with the same URL shape
// and was verified live against a real testnet USDC transfer — see
// docs/adr-403-transaction-history.md.

const EXPLORER_BASES: Record<Network, string> = {
  mainnet: "https://stellar.expert/explorer/public",
  testnet: "https://stellar.expert/explorer/testnet",
};

/**
 * External block-explorer link for a transaction hash (#600).
 *
 * Policy:
 * - Normalizes case/whitespace so `"MAINNET"` and `"testnet"` resolve to their
 *   canonical explorer base URLs.
 * - Throws an explicit Error for unknown or empty networks (`"futurenet"`, `""`,
 *   etc.) rather than silently falling through to testnet or mainnet.
 */
export function explorerTxUrl(txHash: string, network: Network | (string & {})): string {
  const normalized = typeof network === "string" ? network.trim().toLowerCase() : "";
  if (normalized !== "mainnet" && normalized !== "testnet") {
    throw new Error(
      `Unsupported Stellar explorer network "${String(network)}" (expected "testnet" or "mainnet")`,
    );
  }
  return `${EXPLORER_BASES[normalized]}/tx/${txHash}`;
}

