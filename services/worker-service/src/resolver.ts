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
    readonly code: "not_found" | "not_wasm" | "rpc_error",
  ) {
    super(message);
    this.name = "ArtifactResolveError";
  }
}

export interface ContractArtifactResolver {
  /** The deployed wasm hash (lowercase hex) for a contract id. */
  resolveDeployedHash(contractId: string): Promise<string>;
}

export interface RpcArtifactResolverOptions {
  rpcUrl: string;
  /** Injected for tests; defaults to a real rpc.Server. */
  server?: Pick<rpc.Server, "getContractData">;
}

export function createRpcArtifactResolver(
  options: RpcArtifactResolverOptions,
): ContractArtifactResolver {
  const server = options.server ?? new rpc.Server(options.rpcUrl);

  return {
    async resolveDeployedHash(contractId) {
      let entry: Awaited<ReturnType<rpc.Server["getContractData"]>>;
      try {
        entry = await server.getContractData(
          contractId,
          xdr.ScVal.scvLedgerKeyContractInstance(),
          rpc.Durability.Persistent,
        );
      } catch (err) {
        // getContractData throws when the entry is absent — treat that as a
        // clean "not found" so the worker records "failed" with a clear reason,
        // rather than an opaque 500.
        const message = err instanceof Error ? err.message : String(err);
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
