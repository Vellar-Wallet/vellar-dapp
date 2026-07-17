import type { Network } from "@vela/types";

// Client-side wallet configuration. NEXT_PUBLIC_* vars are inlined at build
// time; defaults target Stellar testnet (idea.md §6.1: testnet and mainnet
// must both be configurable).

export interface WebWalletConfig {
  apiUrl: string;
  network: Network;
  rpcUrl: string;
  networkPassphrase: string;
  horizonUrl: string;
  walletWasmHash: string;
  appName: string;
}

// Canonical v1 smart-wallet wasm hash (testnet) per passkey-kit's deployment
// manifest (docs/deployments-testnet-*.md, re-pinned 2026-07-13) and the
// v0.14.0 README. The kit version and this hash are a MATCHED PAIR — verify
// both against the manifest on every passkey-kit upgrade (see
// docs/decisions.md: version-mismatch pairing trap).
const DEFAULT_WALLET_WASM_HASH = "fdefad64b96837147e1c333e51f537b696eab925e9f147e63d597c04e3c903f0";

export function walletConfig(): WebWalletConfig {
  return {
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
    network: process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet",
    rpcUrl: process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    walletWasmHash: process.env.NEXT_PUBLIC_WALLET_WASM_HASH ?? DEFAULT_WALLET_WASM_HASH,
    appName: "VELA Wallet",
  };
}
