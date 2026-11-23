// Signing-key / network coherence guard (architecture-analysis.md §8 Q3).
//
// RA-10 made the NETWORK an explicit, cross-checked setting, but nothing tied
// the KEYS to it: SPONSOR_SECRET_KEY / ATTESTOR_SECRET_KEY / RELAYER_BASE_URL
// are set out-of-band (Render dashboard, sync:false) and a flip of the public
// config (render.yaml → mainnet on 2026-09-20) does NOT change them. A leftover
// testnet sponsor secret paired with mainnet endpoints fails at best and at
// worst funds unauthenticated, sponsor-paid endpoints from a key nobody meant
// to expose on mainnet.
//
// Fix (same class as RA-10: never let an unconfirmed value drive a spend):
//   1. Every configured secret must parse as a Stellar secret seed.
//   2. Every configured secret may be PINNED to its expected public key
//      (<ROLE>_PUBLIC_KEY). A mismatch refuses to boot, naming both PUBLIC keys
//      (never the secret).
//   3. On MAINNET the pin is REQUIRED — an operator must have positively
//      confirmed which account signs. Outside production this can be waived
//      with ALLOW_UNPINNED_SIGNING_KEYS=1; in production it cannot.
//   4. Two roles resolving to the SAME account is refused (a sponsor key
//      reused as the attestor, or vice versa, collapses two blast radii).
//   5. RELAYER_BASE_URL is classified by path (OpenZeppelin Channels: testnet
//      has a /testnet suffix, mainnet is the bare host) and refused on a
//      positive disagreement with the declared network.
//
// The on-chain half — "does the pinned account actually exist on the declared
// network?" — is `probeSigningKeysOnChain`, a non-blocking boot probe, plus the
// operator CLI scripts/verify-signing-keys.ts.
//
// This module takes an injected `derivePublicKey` so service-kit does not grow
// a @stellar/stellar-sdk dependency; every caller already has one.

import type { Network } from "./network-config";

export type SigningKeyRole = "sponsor" | "attestor";

export class SigningKeyConfigError extends Error {
  readonly code = "signing_key_config_incoherent";
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyConfigError";
  }
}

export interface SigningKeyInput {
  role: SigningKeyRole;
  /** Env var the secret came from — used in error messages, never the value. */
  secretEnvVar: string;
  secret: string | undefined;
  /** Env var the pin came from, e.g. SPONSOR_PUBLIC_KEY. */
  pinEnvVar: string;
  expectedPublicKey: string | undefined;
}

export interface SigningKeyCheckInputs {
  network: Network;
  keys: SigningKeyInput[];
  /** RELAYER_BASE_URL, when this process uses the relayer. */
  relayerBaseUrl?: string;
  /** Secret seed → G... public key. MUST throw on an invalid seed. */
  derivePublicKey: (secret: string) => string;
  /** ALLOW_UNPINNED_SIGNING_KEYS === "1". Ignored in production. */
  allowUnpinned?: boolean;
  nodeEnv?: string;
}

export interface ResolvedSigningKey {
  role: SigningKeyRole;
  publicKey: string;
  pinned: boolean;
}

export interface SigningKeyReport {
  network: Network;
  keys: ResolvedSigningKey[];
  relayerNetwork: Network | undefined;
}

/**
 * A relayer URL that is safe to print in a boot error (#755). Credentials
 * (`user:pass@`), the query string and the fragment are dropped, because that is
 * where an API key most often rides along; the scheme, host and path remain,
 * which is exactly what {@link relayerNetwork} uses to classify the URL, so the
 * message stays as useful to an operator.
 */
export function redactRelayerUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<unparseable URL>";
  }
}

/** Classify a relayer base URL by network, or `undefined` when unrecognized. */
export function relayerNetwork(baseUrl: string): Network | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (host === "channels.openzeppelin.com") {
    if (path === "/testnet" || path.startsWith("/testnet/")) return "testnet";
    if (path === "" || path === "/mainnet" || path.startsWith("/mainnet/")) return "mainnet";
    return undefined;
  }
  // Self-hosted / other relayers: only a path segment naming the network counts.
  const segments = path.split("/");
  if (segments.includes("testnet")) return "testnet";
  if (segments.includes("mainnet") || segments.includes("pubnet")) return "mainnet";
  return undefined;
}

/**
 * Validate every configured signing key against the declared network. Throws a
 * SigningKeyConfigError listing EVERY problem (so an operator fixes them in one
 * pass). Returns the resolved public keys for logging — never secrets.
 */
export function verifySigningKeys(inputs: SigningKeyCheckInputs): SigningKeyReport {
  const isProd = (inputs.nodeEnv ?? process.env.NODE_ENV) === "production";
  const allowUnpinned = !isProd && inputs.allowUnpinned === true;
  const problems: string[] = [];
  const resolved: ResolvedSigningKey[] = [];

  for (const key of inputs.keys) {
    const secret = key.secret?.trim();
    const pin = key.expectedPublicKey?.trim() || undefined;

    if (!secret) {
      if (pin) {
        problems.push(
          `${key.pinEnvVar} is set but ${key.secretEnvVar} is not — the ${key.role} key is missing.`,
        );
      }
      continue;
    }

    let publicKey: string;
    try {
      publicKey = inputs.derivePublicKey(secret);
    } catch {
      problems.push(`${key.secretEnvVar} is not a valid Stellar secret seed (expected S...).`);
      continue;
    }

    if (pin) {
      if (pin !== publicKey) {
        problems.push(
          `${key.secretEnvVar} signs as ${publicKey} but ${key.pinEnvVar}=${pin} — ` +
            `the ${key.role} secret is not the account this ${inputs.network} deployment expects.`,
        );
        continue;
      }
    } else if (inputs.network === "mainnet" && !allowUnpinned) {
      problems.push(
        `${key.secretEnvVar} is set on MAINNET without ${key.pinEnvVar}. Pin the expected ` +
          `${key.role} account (${key.pinEnvVar}=${publicKey} if that is correct) to confirm this ` +
          "is the intended mainnet key" +
          (isProd ? "." : ", or set ALLOW_UNPINNED_SIGNING_KEYS=1 outside production."),
      );
      continue;
    }

    resolved.push({ role: key.role, publicKey, pinned: pin !== undefined });
  }

  // Distinct accounts per role.
  const byPublicKey = new Map<string, SigningKeyRole>();
  for (const key of resolved) {
    const other = byPublicKey.get(key.publicKey);
    if (other && other !== key.role) {
      problems.push(
        `The ${other} and ${key.role} keys are the same account (${key.publicKey}). ` +
          "Each role must sign with its own key.",
      );
    }
    byPublicKey.set(key.publicKey, key.role);
  }

  let relayerNet: Network | undefined;
  if (inputs.relayerBaseUrl) {
    relayerNet = relayerNetwork(inputs.relayerBaseUrl);
    if (relayerNet && relayerNet !== inputs.network) {
      problems.push(
        `RELAYER_BASE_URL='${redactRelayerUrl(inputs.relayerBaseUrl)}' looks like ${relayerNet} but ` +
          `STELLAR_NETWORK='${inputs.network}'. Point the relayer (and its RELAYER_API_KEY) at ${inputs.network}.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new SigningKeyConfigError(
      `Signing-key configuration does not match STELLAR_NETWORK='${inputs.network}': ` +
        problems.join(" ") +
        " Refusing to boot rather than sign/spend with an unconfirmed key.",
    );
  }

  return { network: inputs.network, keys: resolved, relayerNetwork: relayerNet };
}

export type AccountProbe = (publicKey: string) => Promise<"found" | "not_found">;

export interface OnChainProbeResult {
  role: SigningKeyRole;
  publicKey: string;
  status: "found" | "not_found" | "error";
  detail?: string;
}

/**
 * Check each resolved key's account exists on the declared network. Never
 * throws — callers log the result. A `not_found` on mainnet is the classic
 * signature of a testnet key left behind after a cutover (or an unfunded one).
 */
export async function probeSigningKeysOnChain(
  report: SigningKeyReport,
  accountExists: AccountProbe,
): Promise<OnChainProbeResult[]> {
  return Promise.all(
    report.keys.map(async (key): Promise<OnChainProbeResult> => {
      try {
        const status = await accountExists(key.publicKey);
        return { role: key.role, publicKey: key.publicKey, status };
      } catch (err) {
        return {
          role: key.role,
          publicKey: key.publicKey,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** Env var names by role — one convention for every service. */
export const SIGNING_KEY_ENV = {
  sponsor: { secretEnvVar: "SPONSOR_SECRET_KEY", pinEnvVar: "SPONSOR_PUBLIC_KEY" },
  attestor: { secretEnvVar: "ATTESTOR_SECRET_KEY", pinEnvVar: "ATTESTOR_PUBLIC_KEY" },
} as const satisfies Record<SigningKeyRole, { secretEnvVar: string; pinEnvVar: string }>;

/** Build a SigningKeyInput for `role` from the environment. */
export function signingKeyFromEnv(
  role: SigningKeyRole,
  env: NodeJS.ProcessEnv = process.env,
): SigningKeyInput {
  const { secretEnvVar, pinEnvVar } = SIGNING_KEY_ENV[role];
  return {
    role,
    secretEnvVar,
    secret: env[secretEnvVar] || undefined,
    pinEnvVar,
    expectedPublicKey: env[pinEnvVar] || undefined,
  };
}
