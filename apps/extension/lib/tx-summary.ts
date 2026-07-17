// Human-readable summary of a transaction the extension is asked to sign.
//
// The approval prompt must show WHAT is being signed, not just that a signature
// was requested (technical-doc.md §8.2 — no silent signing; the user reviews
// before approving). This decodes the XDR into a short per-operation summary,
// and — because the device signer is subject to the account's on-chain policies
// — flags any value transfers so a spending-limit policy makes sense to the
// user. It never signs and never touches the network; a decode failure degrades
// to a safe generic summary rather than throwing.

const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export interface TransferSummary {
  kind: "transfer";
  /** Token contract the transfer targets. */
  token: string;
  to: string;
  /** Raw stroop amount as a string (i128-safe). */
  amount: string;
}

export interface ContractCallSummary {
  kind: "contract-call";
  contract: string;
  fn: string;
}

export interface OtherSummary {
  kind: "other";
  label: string;
}

export type OperationSummary = TransferSummary | ContractCallSummary | OtherSummary;

export interface TransactionSummary {
  operations: OperationSummary[];
  /** True when any operation moves value (transfer) — a spending policy applies. */
  movesValue: boolean;
  /** Set when the XDR could not be decoded; the UI shows a generic warning. */
  undecoded?: boolean;
}

interface StellarSdkLike {
  TransactionBuilder: {
    fromXDR(xdr: string, passphrase: string): unknown;
  };
  Address: {
    fromScAddress(addr: unknown): { toString(): string };
  };
  scValToNative(val: unknown): unknown;
}

/** Decode a transaction XDR into a review summary. `sdk` is injected so this is
 * unit-testable and so the popup keeps lazy-loading stellar-sdk. */
export function summarizeTransaction(
  xdr: string,
  network: "testnet" | "mainnet",
  sdk: StellarSdkLike,
): TransactionSummary {
  try {
    const tx = sdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES[network]) as {
      operations?: unknown[];
    };
    if (!tx.operations || tx.operations.length === 0) {
      return { operations: [{ kind: "other", label: "a transaction" }], movesValue: false };
    }

    const operations = tx.operations.map((op) => summarizeOperation(op, sdk));
    return { operations, movesValue: operations.some((o) => o.kind === "transfer") };
  } catch {
    return {
      operations: [{ kind: "other", label: "a transaction" }],
      movesValue: false,
      undecoded: true,
    };
  }
}

function summarizeOperation(op: unknown, sdk: StellarSdkLike): OperationSummary {
  const operation = op as {
    type?: string;
    func?: unknown;
  };
  if (operation.type !== "invokeHostFunction") {
    return { kind: "other", label: operation.type ?? "an operation" };
  }

  // Reach into the host function for the invoked contract + function + args.
  const invoke = readInvokeContract(operation.func, sdk);
  if (!invoke) return { kind: "contract-call", contract: "a contract", fn: "a function" };

  // SEP-41 transfer(from, to, amount): surface the value movement explicitly.
  if (invoke.fn === "transfer" && invoke.args.length >= 3) {
    const to = scvalToStringSafe(invoke.args[1], sdk);
    const amount = scvalToStringSafe(invoke.args[2], sdk);
    if (to !== undefined && amount !== undefined) {
      return { kind: "transfer", token: invoke.contract, to, amount };
    }
  }

  return { kind: "contract-call", contract: invoke.contract, fn: invoke.fn };
}

interface InvokeContract {
  contract: string;
  fn: string;
  args: unknown[];
}

/** Extract { contract, fn, args } from an invokeHostFunction's HostFunction,
 * tolerating the several shapes the SDK exposes. Returns undefined if not an
 * invokeContract host function. */
function readInvokeContract(func: unknown, sdk: StellarSdkLike): InvokeContract | undefined {
  try {
    const hf = func as {
      switch(): { name: string };
      invokeContract(): {
        contractAddress(): unknown;
        functionName(): { toString(): string };
        args(): unknown[];
      };
    };
    if (hf.switch().name !== "hostFunctionTypeInvokeContract") return undefined;
    const ic = hf.invokeContract();
    const contract = sdk.Address.fromScAddress(ic.contractAddress()).toString();
    // functionName() is a raw ScSymbol (no ScVal switch); its toString() is the
    // symbol text. Passing it to scValToNative would throw.
    const fn = String(ic.functionName());
    return { contract, fn, args: ic.args() };
  } catch {
    return undefined;
  }
}

function scvalToStringSafe(val: unknown, sdk: StellarSdkLike): string | undefined {
  try {
    const native = sdk.scValToNative(val);
    if (native === null || native === undefined) return undefined;
    return typeof native === "object" ? String(native) : `${native}`;
  } catch {
    return undefined;
  }
}

/** Format a stroop amount string as XLM for display. */
export function formatStroops(stroops: string): string {
  try {
    const n = BigInt(stroops);
    const whole = n / 10_000_000n;
    const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return stroops;
  }
}
