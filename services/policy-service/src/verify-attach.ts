import { Address, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@vellar/types";

// L1 full attach verification (security-audit.md). /policies/deploy stamps a
// policy record 'deployed' from a client-supplied txHash. "Exists + succeeded"
// is not enough — any successful hash on the network (a public list) would pass.
// So we DECODE the transaction and confirm it actually invoked add_signer on THIS
// wallet binding THIS policy contract — the same standard as FIX 2 (verify the
// specific fact, not a plausibility proxy).
//
// Network isolation is enforced by WHICH RPC the lookup hits: the caller passes
// a lookup bound to the server-config network's RPC (never the request body,
// V5), so a tx from another network is simply NOT_FOUND -> Unconfirmed.

/** The wallet entrypoints kit.addPolicy may route through. add_signer is the
 * current one; keep update_signer too since kit.updatePolicy reuses the path. */
const ADD_POLICY_FNS = new Set(["add_signer", "update_signer"]);

/** "The chain could not confirm this" — RPC unreachable or tx not found. The
 * caller maps this to 503: the deploy is NOT stamped, and the client may retry. */
export class AttachUnconfirmedError extends Error {
  readonly code = "attach_unconfirmed";
  constructor(message: string) {
    super(message);
    this.name = "AttachUnconfirmedError";
  }
}

/** "The attach verification RPC timed out" — distinct from a confirmed rejection
 * (AttachMismatchError) or not found (AttachUnconfirmedError). Enables caller
 * to differentiate a slow RPC response from genuine attach failure and safely retry. */
export class AttachTimeoutError extends Error {
  readonly code = "attach_timeout";
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "AttachTimeoutError";
  }
}

/** "The chain confirmed something that does NOT match this record" — the tx
 * failed, or attached a different policy/wallet, or is an unrelated call. The
 * caller maps this to 422: a definite lie, not a transient. */
export class AttachMismatchError extends Error {
  readonly code = "attach_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "AttachMismatchError";
  }
}

export interface TxResult {
  status: "SUCCESS" | "NOT_FOUND" | "FAILED";
  /** Base64 transaction envelope XDR — present on SUCCESS. */
  envelopeXdr?: string;
}

/** Fetch a transaction by hash from the server-config network's RPC. Injectable
 * for tests; the real one wraps rpc.Server.getTransaction. */
export type TxLookup = (txHash: string) => Promise<TxResult>;

export interface AttachTarget {
  txHash: string;
  network: Network;
  /** The smart-account the policy instance is bound to (from the record). */
  wallet: string;
  /** The deployed policy contract instance (from record.instance). */
  policyContractId: string;
}

/** Recursively collect every contract/account address appearing in an ScVal —
 * so a policy address nested inside a Signer::Policy enum (a vec) is found. */
function collectAddresses(scv: xdr.ScVal, out: string[]): void {
  try {
    const kind = scv.switch().name;
    if (kind === "scvAddress") {
      out.push(Address.fromScAddress(scv.address()).toString());
      return;
    }
    if (kind === "scvVec") {
      for (const e of scv.vec() ?? []) collectAddresses(e, out);
      return;
    }
    if (kind === "scvMap") {
      for (const e of scv.map() ?? []) {
        collectAddresses(e.key(), out);
        collectAddresses(e.val(), out);
      }
      return;
    }
  } catch {
    // Non-decodable scval — ignore; other args still checked.
  }
}

export interface VerifyAttachOptions {
  networkPassphrase?: string;
  timeoutMs?: number;
}

/**
 * Verify a client-claimed attach transaction on-chain before a record is marked
 * deployed. Throws AttachUnconfirmedError (503-worthy) when the chain can't
 * confirm, AttachMismatchError (422-worthy) when it confirms a mismatch, and
 * AttachTimeoutError when the verification RPC stalls past timeoutMs.
 * Resolves only when the tx exists, succeeded, and invoked add_signer on
 * `wallet` binding `policyContractId`.
 */
export async function verifyAttachTx(
  lookup: TxLookup,
  target: AttachTarget,
  networkPassphraseOrOptions: string | VerifyAttachOptions = "Test SDF Network ; September 2015",
): Promise<void> {
  const options: VerifyAttachOptions =
    typeof networkPassphraseOrOptions === "string"
      ? { networkPassphrase: networkPassphraseOrOptions }
      : networkPassphraseOrOptions;
  const networkPassphrase =
    options.networkPassphrase ?? "Test SDF Network ; September 2015";
  const timeoutMs = options.timeoutMs;

  let res: TxResult;
  try {
    if (timeoutMs && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AttachTimeoutError(
                `Attach verification timed out for tx ${target.txHash} after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      });
      try {
        res = await Promise.race([lookup(target.txHash), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      res = await lookup(target.txHash);
    }
  } catch (err) {
    if (err instanceof AttachTimeoutError) {
      throw err;
    }
    // RPC unreachable — cannot confirm. Fail closed, retryable.
    throw new AttachUnconfirmedError(
      `Could not reach the network to verify the attach tx: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status === "NOT_FOUND") {
    // Not on THIS network (or not yet visible). Cannot confirm — retryable.
    throw new AttachUnconfirmedError(
      `Attach tx ${target.txHash} not found on the ${target.network} network.`,
    );
  }
  if (res.status === "FAILED" || !res.envelopeXdr) {
    // The tx ran and did NOT succeed (or no envelope) — a definite mismatch.
    throw new AttachMismatchError(`Attach tx ${target.txHash} did not succeed on-chain.`);
  }

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(res.envelopeXdr, networkPassphrase);
  } catch (err) {
    throw new AttachMismatchError(
      `Attach tx envelope could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!("operations" in tx) || tx.operations.length !== 1) {
    throw new AttachMismatchError("Attach tx must be a single invokeHostFunction operation.");
  }
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") {
    throw new AttachMismatchError("Attach tx is not an invokeHostFunction.");
  }

  let ic: xdr.InvokeContractArgs;
  try {
    ic = op.func.invokeContract();
  } catch {
    throw new AttachMismatchError("Attach tx host function is not a contract invocation.");
  }

  // 1. Invoked contract must be THIS wallet (the smart account attaching a policy).
  const invoked = Address.fromScAddress(ic.contractAddress()).toString();
  if (invoked !== target.wallet) {
    throw new AttachMismatchError(
      `Attach tx invoked ${invoked}, not the record's wallet ${target.wallet}.`,
    );
  }

  // 2. Function must be the wallet's add/update-signer entrypoint.
  const fn = ic.functionName().toString();
  if (!ADD_POLICY_FNS.has(fn)) {
    throw new AttachMismatchError(`Attach tx called ${fn}, not add_signer/update_signer.`);
  }

  // 3. THIS policy contract must appear in the signer args (the Policy signer).
  const addrs: string[] = [];
  for (const a of ic.args()) collectAddresses(a, addrs);
  if (!addrs.includes(target.policyContractId)) {
    throw new AttachMismatchError(
      `Attach tx does not bind policy ${target.policyContractId} (found: ${addrs.join(", ") || "none"}).`,
    );
  }
}
