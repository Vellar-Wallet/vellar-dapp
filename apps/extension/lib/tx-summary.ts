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
  /** True when the transaction executes multiple operations in a batch. */
  isBatch?: boolean;
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

const BATCH_FN_NAMES = new Set(["batch", "execute_batch", "exec_batch", "multicall"]);

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
      return {
        operations: [{ kind: "other", label: "a transaction" }],
        movesValue: false,
        isBatch: false,
      };
    }

    const operations: OperationSummary[] = [];
    for (const op of tx.operations) {
      try {
        operations.push(...summarizeOperationOrBatch(op, sdk));
      } catch {
        // If an individual operation in a multi-op batch fails to decode,
        // degrade only that operation rather than failing the entire summary.
        operations.push({ kind: "other", label: "an operation" });
      }
    }

    return {
      operations,
      movesValue: operations.some((o) => o.kind === "transfer"),
      isBatch: operations.length > 1,
    };
  } catch {
    return {
      operations: [{ kind: "other", label: "a transaction" }],
      movesValue: false,
      isBatch: false,
      undecoded: true,
    };
  }
}

function summarizeOperationOrBatch(op: unknown, sdk: StellarSdkLike): OperationSummary[] {
  const operation = op as {
    type?: string;
    func?: unknown;
  };
  if (operation.type !== "invokeHostFunction") {
    return [{ kind: "other", label: operation.type ?? "an operation" }];
  }

  const hostKind = readHostFunctionKind(operation.func);
  if (hostKind === "hostFunctionTypeUploadContractWasm") {
    return [{ kind: "other", label: "Upload contract WASM" }];
  }
  if (
    hostKind === "hostFunctionTypeCreateContract" ||
    hostKind === "hostFunctionTypeCreateContractV2"
  ) {
    return [{ kind: "other", label: "Deploy contract" }];
  }

  // Reach into the host function for the invoked contract + function + args.
  const invoke = readInvokeContract(operation.func, sdk);
  if (!invoke) {
    return [{ kind: "contract-call", contract: "a contract", fn: "a function" }];
  }

  // Expand Soroban batch / multicall invocations when the first argument is a
  // vector of sub-invocation descriptors.
  if (BATCH_FN_NAMES.has(invoke.fn) && invoke.args.length > 0) {
    const expanded = tryExpandBatchSubcalls(invoke.args[0], sdk);
    if (expanded && expanded.length > 0) {
      return expanded;
    }
  }

  return [classifyContractInvocation(invoke.contract, invoke.fn, invoke.args, sdk)];
}

function classifyContractInvocation(
  contract: string,
  fn: string,
  args: unknown[],
  sdk: StellarSdkLike,
): OperationSummary {
  // SEP-41 transfer(from, to, amount): surface the value movement explicitly.
  if (fn === "transfer" && args.length >= 3) {
    const to = scvalToStringSafe(args[1], sdk);
    const amount = scvalToStringSafe(args[2], sdk);
    if (to !== undefined && amount !== undefined) {
      return { kind: "transfer", token: contract, to, amount };
    }
  }
  return { kind: "contract-call", contract, fn };
}

function tryExpandBatchSubcalls(
  rawVecArg: unknown,
  sdk: StellarSdkLike,
): OperationSummary[] | undefined {
  try {
    const native = sdk.scValToNative(rawVecArg);
    if (!Array.isArray(native) || native.length === 0) return undefined;

    return native.map((entry): OperationSummary => {
      try {
        if (Array.isArray(entry) && entry.length >= 2) {
          const contract = typeof entry[0] === "string" ? entry[0] : String(entry[0] ?? "");
          const fn = typeof entry[1] === "string" ? entry[1] : String(entry[1] ?? "");
          const subArgs = Array.isArray(entry[2]) ? entry[2] : [];
          if (!contract || !fn) {
            return { kind: "other", label: "Unrecognized batch operation" };
          }
          if (
            fn === "transfer" &&
            subArgs.length >= 3 &&
            subArgs[1] != null &&
            subArgs[2] != null
          ) {
            return {
              kind: "transfer",
              token: contract,
              to: String(subArgs[1]),
              amount: String(subArgs[2]),
            };
          }
          return { kind: "contract-call", contract, fn };
        }
        if (typeof entry === "object" && entry !== null) {
          const rec = entry as Record<string, unknown>;
          const contract = typeof rec.contract === "string" ? rec.contract : "";
          const fn =
            typeof rec.fn === "string"
              ? rec.fn
              : typeof rec.function === "string"
                ? rec.function
                : "";
          const subArgs = Array.isArray(rec.args) ? rec.args : [];
          if (!contract || !fn) {
            return { kind: "other", label: "Unrecognized batch operation" };
          }
          if (
            fn === "transfer" &&
            subArgs.length >= 3 &&
            subArgs[1] != null &&
            subArgs[2] != null
          ) {
            return {
              kind: "transfer",
              token: contract,
              to: String(subArgs[1]),
              amount: String(subArgs[2]),
            };
          }
          return { kind: "contract-call", contract, fn };
        }
        return { kind: "other", label: "Unrecognized batch operation" };
      } catch {
        return { kind: "other", label: "Unrecognized batch operation" };
      }
    });
  } catch {
    return undefined;
  }
}

function readHostFunctionKind(func: unknown): string | undefined {
  try {
    const hf = func as { switch?(): { name?: string } };
    return hf?.switch?.()?.name;
  } catch {
    return undefined;
  }
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

function shortAddress(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

/**
 * Formats a single `OperationSummary` into a concise human-readable line.
 * When `index` and `total` (`total > 1`) are provided, prefixes with
 * `"Step X of Y: "` so multi-operation batches read clearly in order.
 */
export function formatOperationSummary(
  op: OperationSummary,
  index?: number,
  total?: number,
): string {
  const prefix =
    index !== undefined && total !== undefined && total > 1
      ? `Step ${index + 1} of ${total}: `
      : "";
  if (op.kind === "transfer") {
    return `${prefix}Send ${formatStroops(op.amount)} XLM → ${shortAddress(op.to)}`;
  }
  if (op.kind === "contract-call") {
    return `${prefix}Call ${op.fn} on ${shortAddress(op.contract)}`;
  }
  return `${prefix}Operation: ${op.label}`;
}

/**
 * Formats all operations in a `TransactionSummary` into an ordered list of
 * human-readable step descriptions.
 */
export function formatTransactionBatchSummary(summary: TransactionSummary): string[] {
  const total = summary.operations.length;
  return summary.operations.map((op, i) => formatOperationSummary(op, i, total));
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
