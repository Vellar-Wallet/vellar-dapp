import type { PairedWallet } from "./state";

// L4: bound the device signer's signature-expiration ledger CLIENT-SIDE.
//
// passkey-kit, given no explicit expiration, calls getLatestLedger() on the
// wallet's rpcUrl and sets signatureExpirationLedger = latest + timeout/5. That
// rpcUrl is caller-supplied (from pairing), so a hostile RPC that inflates
// `latest` widens the on-chain replay window of the one signed auth entry. The
// kit only asserts the value is a valid u32 — no upper bound.
//
// Fix: take the anchor from a TRUSTED per-network RPC the page cannot influence
// (never wallet.rpcUrl), then add a fixed, capped window and pass the result to
// kit.signAuthEntry({ expiration }) — which then never calls getLatestLedger.

/**
 * Maximum signature-expiration window, in ledgers (~5s each ⇒ ~5 min).
 *
 * Tradeoff (approval latency vs replay window): the window must cover the worst
 * realistic approval — user gets the popup, switches apps, returns, approves —
 * not just the happy path, or correct signatures fail with an undiagnosable
 * error. The replay exposure traded away is small: the device key is already a
 * 7-day expiring co-signer, further bounded by any attached policy contracts, so
 * ~5 min of extra replay window is a good deal against a false-failure rate on
 * approvals. 60 ledgers is that balance; do not widen it toward an hour.
 */
export const MAX_EXPIRATION_LEDGERS = 60;

/** u32 ceiling — the kit rejects a signatureExpirationLedger outside u32. */
const U32_MAX = 0xffffffff;

/** Pinned trusted Soroban RPC per network. Testnet is SDF's public endpoint
 * (the same one the backend services default to). Mainnet has no universal
 * public RPC, so it is operator-configured via WXT_PUBLIC_MAINNET_RPC_URL; when
 * unset, mainnet signing fails closed rather than trusting the caller's rpcUrl. */
const TESTNET_TRUSTED_RPC = "https://soroban-testnet.stellar.org";

/** Thrown when no trusted RPC is available for the wallet's network — signing
 * must refuse rather than fall back to the caller-supplied rpcUrl. */
export class TrustedRpcUnavailableError extends Error {
  readonly code = "trusted_rpc_unavailable";
  constructor(network: string) {
    super(
      `No trusted RPC configured for ${network}; refusing to sign rather than ` +
        "trusting the caller-supplied endpoint for the signature expiration. " +
        "Set WXT_PUBLIC_MAINNET_RPC_URL.",
    );
    this.name = "TrustedRpcUnavailableError";
  }
}

/**
 * The trusted RPC URL for `network`, page-uninfluenceable. `mainnetRpcUrl` is
 * the build-time WXT_PUBLIC_MAINNET_RPC_URL (never the paired wallet's rpcUrl).
 * @throws TrustedRpcUnavailableError when mainnet has no configured RPC.
 */
export function resolveTrustedRpcUrl(
  network: PairedWallet["network"],
  mainnetRpcUrl: string | undefined,
): string {
  if (network === "testnet") return TESTNET_TRUSTED_RPC;
  const configured = mainnetRpcUrl?.trim();
  if (!configured) throw new TrustedRpcUnavailableError(network);
  return configured;
}

/**
 * The bounded signature-expiration ledger for a given trusted anchor. The ADDED
 * span is always exactly MAX_EXPIRATION_LEDGERS — never anchor-proportional — so
 * an inflated anchor cannot widen the window. Clamped to u32.
 * @throws if the anchor is not a non-negative integer.
 */
export function boundedExpirationLedger(anchorLedger: number): number {
  if (!Number.isInteger(anchorLedger) || anchorLedger < 0) {
    throw new Error(`Trusted RPC returned a non-integer ledger anchor: ${anchorLedger}`);
  }
  return Math.min(anchorLedger + MAX_EXPIRATION_LEDGERS, U32_MAX);
}

/** Build-time mainnet trusted RPC, from WXT_PUBLIC_MAINNET_RPC_URL. */
export function configuredMainnetRpcUrl(): string | undefined {
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return (env?.WXT_PUBLIC_MAINNET_RPC_URL as string | undefined) || undefined;
}

/**
 * Thrown when a device signer's expiration timestamp has been reached or passed
 * at the moment a signing request is evaluated.
 */
export class SignerExpiredError extends Error {
  readonly code = "signer_expired" as const;
  readonly expiresAtMs: number;
  readonly requestTimeMs: number;

  constructor(expiresAtMs: number, requestTimeMs: number) {
    super(
      `Device signer expired at ${expiresAtMs}ms (request evaluated at ${requestTimeMs}ms); re-pair the extension to continue signing.`,
    );
    this.name = "SignerExpiredError";
    this.expiresAtMs = expiresAtMs;
    this.requestTimeMs = requestTimeMs;
  }
}

/**
 * Evaluates whether a device signer with expiration timestamp `expiresAtMs`
 * has expired at `requestTimeMs`.
 *
 * Boundary semantics (fail-closed at exact expiry instant `t`):
 * - `expiresAtMs = t - 1` (`requestTimeMs > expiresAtMs`): **expired** (`true`)
 * - `expiresAtMs = t` (`requestTimeMs === expiresAtMs`): **expired** (`true`)
 *   — a signer whose validity window `[createdAt, expiresAtMs)` ends at `t`
 *   is no longer valid at instant `t`.
 * - `expiresAtMs = t + 1` (`requestTimeMs < expiresAtMs`): **active** (`false`)
 */
export function isSignerExpired(expiresAtMs: number, requestTimeMs: number = Date.now()): boolean {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(requestTimeMs)) {
    throw new Error("Signer expiration and request timestamps must be finite numbers");
  }
  return requestTimeMs >= expiresAtMs;
}

/**
 * Asserts that a signer has not expired at `requestTimeMs`.
 * Throws `SignerExpiredError` when `requestTimeMs >= expiresAtMs`.
 */
export function assertSignerNotExpired(
  expiresAtMs: number | undefined,
  requestTimeMs: number = Date.now(),
): void {
  if (expiresAtMs === undefined) return;
  if (isSignerExpired(expiresAtMs, requestTimeMs)) {
    throw new SignerExpiredError(expiresAtMs, requestTimeMs);
  }
}
