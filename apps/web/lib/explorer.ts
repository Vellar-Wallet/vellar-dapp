import type { Network } from "@vellar/types";

// Explorer links (issue #403: "Each row links to a working explorer entry for
// the tx hash"). stellar.expert serves both networks with the same URL shape
// and was verified live against a real testnet USDC transfer — see
// docs/adr-403-transaction-history.md.

export function explorerTxUrl(txHash: string, network: Network): string {
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${txHash}`;
}
