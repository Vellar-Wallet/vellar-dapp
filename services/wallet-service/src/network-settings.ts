import { resolveNetwork, type Network } from "@vellar/service-kit";

// One trusted network configuration for wallet-service (security-audit.md RA-10
// class). index.ts used to derive the RPC url and passphrase separately in five
// places as `relayer?.x ?? <testnet default>`, so with the relayer unset they
// ignored STELLAR_RPC_URL / STELLAR_NETWORK_PASSPHRASE: a sponsor-only mainnet
// service could not boot, and the ledger lookup, sponsor submitter and
// scoping passphrase could disagree with the network that was validated. They
// now all read the single value resolved here, from the EXPLICIT STELLAR_NETWORK.

const PER_NETWORK = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    rpcUrl: "https://mainnet.sorobanrpc.com",
    passphrase: "Public Global Stellar Network ; September 2015",
  },
} as const;

export interface NetworkSettings {
  network: Network;
  /** The trusted RPC: used for the ledger lookup AND the sponsor submitter. */
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Resolve the network, RPC url and passphrase from the environment.
 *
 * STELLAR_NETWORK is required and never defaulted. STELLAR_RPC_URL and
 * STELLAR_NETWORK_PASSPHRASE override the default FOR THAT NETWORK (never the
 * testnet default by accident), and the three values are cross-checked by
 * resolveNetwork, which throws NetworkConfigError on any disagreement or on an
 * unset / unknown network.
 */
export function networkSettingsFromEnv(env: NodeJS.ProcessEnv): NetworkSettings {
  const declared = env.STELLAR_NETWORK?.trim();
  // A missing or invalid STELLAR_NETWORK has no defaults to offer; resolveNetwork
  // then throws its own loud error before looking at the empty strings.
  const defaults = declared === "testnet" || declared === "mainnet" ? PER_NETWORK[declared] : null;
  const rpcUrl = env.STELLAR_RPC_URL?.trim() || defaults?.rpcUrl || "";
  const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE?.trim() || defaults?.passphrase || "";
  const network = resolveNetwork({
    network: env.STELLAR_NETWORK,
    passphrase: networkPassphrase,
    rpcUrl,
  });
  return { network, rpcUrl, networkPassphrase };
}

export class RpcNetworkMismatchError extends Error {
  readonly code = "rpc_network_mismatch";
  constructor(expected: string, actual: string | undefined) {
    super(
      `The RPC reports network passphrase ${JSON.stringify(actual ?? "")} but the service is ` +
        `configured for ${JSON.stringify(expected)}. Refusing to boot rather than compare ` +
        "signature expiration ledgers or sponsor fees against the wrong network.",
    );
    this.name = "RpcNetworkMismatchError";
  }
}

export class RpcUnreachableError extends Error {
  readonly code = "rpc_unreachable";
  constructor(cause: unknown) {
    super(
      `Could not reach the RPC to verify its network: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "RpcUnreachableError";
  }
}

export interface NetworkProbe {
  getNetwork(): Promise<{ passphrase: string }>;
}

export interface ProbeOptions {
  /** Total tries for a transient failure (default 3). A mismatch is never retried. */
  attempts?: number;
  /** Base delay between tries in ms, multiplied by the try number (default 500). */
  delayMs?: number;
}

/** Throws RpcNetworkMismatchError unless the RPC's passphrase equals `expected`
 * exactly; throws RpcUnreachableError if it cannot be asked after the retries. */
export async function assertRpcMatchesPassphrase(
  rpc: NetworkProbe,
  expected: string,
  { attempts = 3, delayMs = 500 }: ProbeOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { passphrase } = await rpc.getNetwork();
      if (!passphrase || passphrase !== expected) {
        throw new RpcNetworkMismatchError(expected, passphrase);
      }
      return;
    } catch (err) {
      if (err instanceof RpcNetworkMismatchError) throw err; // the answer will not change
      lastError = err;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw new RpcUnreachableError(lastError);
}

export interface BootCheckOptions extends ProbeOptions {
  /** NODE_ENV === "production". */
  production: boolean;
  warn: (message: string) => void;
}

/**
 * The boot-time network check. A passphrase mismatch refuses to boot
 * everywhere. An UNREACHABLE rpc refuses in production (the network cannot be
 * verified, and every submission needs this RPC), but only warns elsewhere so
 * offline local development still starts.
 */
export async function verifyRpcAtBoot(
  rpc: NetworkProbe,
  expected: string,
  { production, warn, ...probe }: BootCheckOptions,
): Promise<void> {
  try {
    await assertRpcMatchesPassphrase(rpc, expected, probe);
  } catch (err) {
    if (err instanceof RpcUnreachableError && !production) {
      warn(
        `Could not verify the RPC's network at boot (continuing, not production): ${err.message}`,
      );
      return;
    }
    throw err;
  }
}
