import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { normalizeHash } from "./artifact";

// ContractArtifactResolver (idea.md §6.3): resolves the wasm hash actually
// deployed on-chain for a contract id. This is the trust anchor of the whole
// pipeline — the value a locally-rebuilt artifact must reproduce. It is read
// straight from the ledger (not from anything the submitter provides), so a
// submitter cannot influence what their build is compared against.
//
// A Soroban contract's instance ledger entry carries a ContractExecutable that
// is either a wasm hash (normal contracts) or the built-in "stellar asset"
// executable (SAC tokens — no source to verify). We read the instance entry via
// getContractData(contractId, ScVal::LedgerKeyContractInstance) and extract the
// wasm hash from the executable.

export class ArtifactResolveError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_wasm" | "rpc_error" | "timeout",
  ) {
    super(message);
    this.name = "ArtifactResolveError";
  }
}

/** Default cap on the RPC round-trip (getContractData had no timeout at all
 * before — a hung upstream RPC endpoint could stall a worker job
 * indefinitely). Env-overridable per deployment's real RPC latency profile. */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export interface ContractArtifactResolver {
  /** The deployed wasm hash (lowercase hex) for a contract id. */
  resolveDeployedHash(contractId: string): Promise<string>;
}

export interface RpcArtifactResolverOptions {
  rpcUrl: string;
  /** Injected for tests; defaults to a real rpc.Server. */
  server?: Pick<rpc.Server, "getContractData">;
  /** Cap on the RPC round-trip. Default DEFAULT_RPC_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Rejects with a sentinel Error after `ms` if `promise` hasn't settled. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("__rpc_timeout__")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createRpcArtifactResolver(
  options: RpcArtifactResolverOptions,
): ContractArtifactResolver {
  const server = options.server ?? new rpc.Server(options.rpcUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  return {
    async resolveDeployedHash(contractId) {
      let entry: Awaited<ReturnType<rpc.Server["getContractData"]>>;
      try {
        entry = await withTimeout(
          server.getContractData(
            contractId,
            xdr.ScVal.scvLedgerKeyContractInstance(),
            rpc.Durability.Persistent,
          ),
          timeoutMs,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "__rpc_timeout__") {
          // Distinct from rpc_error (issue #330): a timeout is a transient
          // upstream condition, not evidence the contract is missing or the
          // RPC call itself failed — the caller (verify.ts) treats "timeout"
          // as retryable rather than a terminal "failed" verdict.
          throw new ArtifactResolveError(
            `contract metadata lookup for ${contractId} timed out after ${timeoutMs}ms`,
            "timeout",
          );
        }
        // getContractData throws when the entry is absent — treat that as a
        // clean "not found" so the worker records "failed" with a clear reason,
        // rather than an opaque 500.
        if (/not found|could not (be )?found|missing/i.test(message)) {
          throw new ArtifactResolveError(`contract ${contractId} not found on-chain`, "not_found");
        }
        throw new ArtifactResolveError(message, "rpc_error");
      }

      const instance = entry.val.contractData().val().instance();
      const executable = instance.executable();
      if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
        // A Stellar Asset Contract (SAC) has no user source to verify.
        throw new ArtifactResolveError(
          `contract ${contractId} is a built-in Stellar Asset Contract, not a wasm contract`,
          "not_wasm",
        );
      }

      const wasmHash = executable.wasmHash();
      return normalizeHash(Buffer.from(wasmHash).toString("hex"));
    },
  };
}

/** A resolver over a fixed map, for tests and offline pipelines. */
export function createStaticArtifactResolver(
  hashes: Record<string, string>,
): ContractArtifactResolver {
  return {
    async resolveDeployedHash(contractId) {
      const hash = hashes[contractId];
      if (!hash) {
        throw new ArtifactResolveError(`no deployed hash for ${contractId}`, "not_found");
      }
      return normalizeHash(hash);
    },
  };
}

/** Guard so a mistyped id never reaches RPC. */
export function isContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value);
}

export { Contract };
