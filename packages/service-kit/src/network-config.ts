// Explicit network resolution for the worker (security-audit.md RA-10).
//
// The attestor's mainnet guard (attestor-guard.ts) used to INFER "which network
// am I on" from `networkPassphrase` — a value whose real job is signing and
// which defaults to testnet when STELLAR_NETWORK_PASSPHRASE is unset. So a
// worker pointed at a mainnet RPC/registry while forgetting the passphrase
// mis-classified as testnet and silently skipped the M5 single-key guard.
//
// Fix (the class the sweep targets: never derive a security decision from a
// value that has a permissive-side default): the network is now an EXPLICIT,
// REQUIRED setting (STELLAR_NETWORK = testnet | mainnet). Absence fails closed —
// it does NOT default to testnet. The declared network is then cross-checked
// against the passphrase and the RPC host in BOTH directions; any disagreement,
// or a value we can't positively classify, refuses to boot with a loud error
// that NAMES the disagreeing values.

export type Network = "testnet" | "mainnet";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export class NetworkConfigError extends Error {
  readonly code = "network_config_incoherent";
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

/** Classify a passphrase as a network, or `undefined` when it matches neither
 * canonical value (we cannot positively confirm it — treated as a disagreement,
 * fail closed). */
function passphraseNetwork(passphrase: string): Network | undefined {
  if (passphrase === TESTNET_PASSPHRASE) return "testnet";
  if (passphrase === MAINNET_PASSPHRASE) return "mainnet";
  return undefined;
}

/** Classify an RPC URL as a network by host, or `undefined` when unrecognized.
 * SDF's testnet endpoint is well-known; any other host is treated as mainnet-ish
 * ONLY when it isn't the testnet host — but an unrecognized host stays undefined
 * so it can't silently confirm either side. */
function rpcNetwork(rpcUrl: string): Network | undefined {
  let host: string;
  try {
    host = new URL(rpcUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "soroban-testnet.stellar.org" || host.endsWith(".testnet.stellar.org")) {
    return "testnet";
  }
  // Recognized mainnet endpoints. Extend as operators standardize on providers.
  if (
    host === "mainnet.sorobanrpc.com" ||
    host === "soroban-rpc.mainnet.stellar.gateway.fm" ||
    host.endsWith(".mainnet.stellar.org")
  ) {
    return "mainnet";
  }
  return undefined; // unrecognized host — cannot confirm; caller fails closed
}

export interface NetworkInputs {
  /** process.env.STELLAR_NETWORK — REQUIRED, no default. */
  network: string | undefined;
  passphrase: string;
  rpcUrl: string;
  /** Every endpoint in the RPC pool (rpc-pool.ts), when more than one is
   * configured. EACH is cross-checked like `rpcUrl` — failover must never be
   * able to rotate onto an endpoint for the other network. */
  rpcUrls?: string[];
}

/**
 * Resolve the worker's network from the EXPLICIT STELLAR_NETWORK setting, and
 * refuse to boot if it is unset, unknown, or disagrees with the passphrase or
 * RPC in either direction. Returns the confirmed network.
 */
export function resolveNetwork(inputs: NetworkInputs): Network {
  const declared = inputs.network?.trim();
  if (!declared) {
    throw new NetworkConfigError(
      "STELLAR_NETWORK is not set. Set it explicitly to 'testnet' or 'mainnet' — the worker " +
        "refuses to infer the network (a missing value must never default to the permissive side).",
    );
  }
  if (declared !== "testnet" && declared !== "mainnet") {
    throw new NetworkConfigError(
      `STELLAR_NETWORK='${declared}' is not a valid network. Use 'testnet' or 'mainnet'.`,
    );
  }
  const network = declared as Network;

  // Cross-check every classifiable signal against the declared network. A signal
  // that classifies to the OTHER network, or that we cannot classify at all,
  // is a disagreement — we do not guess which half is right.
  const disagreements: string[] = [];

  const pass = passphraseNetwork(inputs.passphrase);
  if (pass !== network) {
    disagreements.push(
      pass
        ? `passphrase looks like ${pass}`
        : "passphrase is unrecognized (matches neither canonical network)",
    );
  }

  for (const rpcUrl of new Set([inputs.rpcUrl, ...(inputs.rpcUrls ?? [])])) {
    const rpc = rpcNetwork(rpcUrl);
    if (rpc !== network) {
      disagreements.push(
        rpc ? `RPC host '${rpcUrl}' looks like ${rpc}` : `RPC host '${rpcUrl}' is unrecognized`,
      );
    }
  }

  if (disagreements.length > 0) {
    throw new NetworkConfigError(
      `STELLAR_NETWORK='${network}' but the configuration is incoherent: ${disagreements.join("; ")}. ` +
        "Refusing to boot rather than guess which value is correct — align STELLAR_NETWORK, " +
        "STELLAR_NETWORK_PASSPHRASE, and STELLAR_RPC_URL / STELLAR_RPC_URLS.",
    );
  }

  return network;
}
