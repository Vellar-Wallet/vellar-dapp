// Maintained wallet-wasm changelog (#572). When the app's pinned
// `walletWasmHash` (lib/config.ts) advances, add an entry here describing what
// changed in that wallet contract version. The wallet-upgrade card reads this
// so the user sees what they are approving instead of a bare hash. Keep entries
// keyed by the FULL lower-case hex wasm hash the ledger reports — that is the
// only stable identifier shared by config, the chain and this file.

export interface WalletChangelogEntry {
  /** Full lower-case hex wasm hash this entry describes. */
  wasmHash: string;
  /** Human version label for the wallet contract build. */
  version: string;
  /** One-line summary of what changed for the account owner. */
  summary: string;
  /** Optional link to a longer write-up (release note, PR, audit). */
  url?: string;
}

export const walletChangelog: WalletChangelogEntry[] = [
  {
    wasmHash: "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0",
    version: "v1",
    summary:
      "Baseline smart-wallet contract: passkey signers, policy co-signers, agent session keys and in-place code upgrade.",
    url: "https://github.com/Vellar-Wallet/vellar-dapp/blob/dev/docs/open-work-catalogue.md",
  },
];

export function normalizeChangelogHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

/** Look up the changelog entry for a wasm hash. `undefined` when the pinned
 * hash has no entry yet — callers must show a fallback, never a broken link. */
export function getWalletChangelogEntry(hash: string): WalletChangelogEntry | undefined {
  const wanted = normalizeChangelogHash(hash);
  return walletChangelog.find((e) => normalizeChangelogHash(e.wasmHash) === wanted);
}
