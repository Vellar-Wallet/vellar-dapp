import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import type { RpcPool } from "@vellar/service-kit";
import type { AttestationSubmitter } from "./attestor";

// The real AttestationSubmitter: invokes the AttestationRegistry contract over
// Soroban RPC as the attestor account. Writes (upsert/revoke) are
// build → simulate/assemble → sign → submit → poll-to-final; reads
// (isAttested) are pure simulations and cost nothing.
//
// The attestor secret is handled exactly like the sponsor secret elsewhere in
// the backend: env-only, server-side, never logged.

export type RegistrySubmissionErrorClass = "registry_transient" | "generic_transient" | "terminal";

export class RegistrySubmissionError extends Error {
  constructor(
    message: string,
    readonly errorClass: RegistrySubmissionErrorClass,
  ) {
    super(message);
    this.name = "RegistrySubmissionError";
  }
}

export interface BackoffPolicy {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface RegistrySubmitterBackoffConfig {
  /**
   * Dedicated fast backoff for registry-specific transient errors (e.g. sequence
   * number mismatch `txBAD_SEQ` or temporary ledger/registry contention), where
   * re-fetching the account sequence number and immediately resubmitting resolves
   * the conflict without waiting for a full network backoff cycle.
   */
  registryTransient?: Partial<BackoffPolicy>;
  /**
   * Exponential backoff for generic RPC/network transient errors.
   */
  genericTransient?: Partial<BackoffPolicy>;
}

export const DEFAULT_REGISTRY_TRANSIENT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 150,
  multiplier: 1.5,
  maxDelayMs: 1_000,
  maxRetries: 3,
};

export const DEFAULT_GENERIC_TRANSIENT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 8_000,
  maxRetries: 3,
};

const REGISTRY_TRANSIENT_PATTERNS = [
  /tx_?bad_?seq/i,
  /bad_?seq/i,
  /sequence\s*(number)?\s*(mismatch|conflict|stale|out of date)/i,
  /stale\s+sequence/i,
  /try_again_later/i,
  /temporary[_\s-]lock/i,
  /resource[_\s-]busy/i,
  /ledger[_\s-]conflict/i,
  /tx_?too_?late/i,
];

const GENERIC_TRANSIENT_PATTERNS = [
  /econnreset/i,
  /etimedout/i,
  /econnrefused/i,
  /eai_again/i,
  /enotfound/i,
  /fetch\s+failed/i,
  /network\s+error/i,
  /socket\s+hang\s+up/i,
  /http\s+(429|502|503|504)/i,
  /rate[_\s-]limit/i,
  /timed?\s*out/i,
  /not\s+final\s+after/i,
];

/**
 * Classifies an error encountered during registry transaction preparation,
 * submission, or finality polling into:
 * - `"registry_transient"`: sequence number mismatch (`txBAD_SEQ`) or temporary
 *   registry/ledger lock that should be retried quickly after re-fetching the
 *   account sequence number.
 * - `"generic_transient"`: network or RPC transport failure that warrants a
 *   slower exponential backoff.
 * - `"terminal"`: permanent validation, auth, or on-chain execution failure that
 *   must not be retried.
 */
export function classifyRegistrySubmissionError(error: unknown): RegistrySubmissionErrorClass {
  if (error instanceof RegistrySubmissionError) {
    return error.errorClass;
  }

  const rawMessage =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");

  for (const pattern of REGISTRY_TRANSIENT_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return "registry_transient";
    }
  }

  for (const pattern of GENERIC_TRANSIENT_PATTERNS) {
    if (pattern.test(rawMessage)) {
      return "generic_transient";
    }
  }

  return "terminal";
}

function resolveBackoffPolicy(
  errorClass: Exclude<RegistrySubmissionErrorClass, "terminal">,
  config?: RegistrySubmitterBackoffConfig,
): BackoffPolicy {
  if (errorClass === "registry_transient") {
    return {
      ...DEFAULT_REGISTRY_TRANSIENT_BACKOFF,
      ...config?.registryTransient,
    };
  }
  return {
    ...DEFAULT_GENERIC_TRANSIENT_BACKOFF,
    ...config?.genericTransient,
  };
}

/**
 * Computes the backoff delay in milliseconds for a given transient error class
 * and 1-based retry attempt number.
 */
export function computeBackoffDelayMs(
  errorClass: Exclude<RegistrySubmissionErrorClass, "terminal">,
  attempt: number,
  config?: RegistrySubmitterBackoffConfig,
): number {
  const policy = resolveBackoffPolicy(errorClass, config);
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.round(policy.initialDelayMs * Math.pow(policy.multiplier, exponent));
  return Math.min(policy.maxDelayMs, raw);
}

export interface RegistryRetryEvent {
  method: string;
  attempt: number;
  errorClass: Exclude<RegistrySubmissionErrorClass, "terminal">;
  delayMs: number;
  error: unknown;
}

export interface RegistrySubmitterOptions {
  rpcUrl: string;
  networkPassphrase: string;
  registryContractId: string;
  attestorSecretKey: string;
  /** Injected for tests; defaults to a real rpc.Server. */
  server?: Pick<
    rpc.Server,
    | "getAccount"
    | "simulateTransaction"
    | "prepareTransaction"
    | "sendTransaction"
    | "getTransaction"
    | "getLatestLedger"
  >;
  /** Health-checked endpoint pool. When set, each call runs against the
   * pool's current endpoint, chosen when the call starts and kept for the
   * whole build → send → poll sequence. Writes are NOT retried on another
   * endpoint — a failed call surfaces as before and the attestor retries it. */
  rpcPool?: RpcPool;
  /** Optional per-error-class backoff overrides. */
  backoff?: RegistrySubmitterBackoffConfig;
  /** Injectable sleep implementation for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional callback invoked prior to each retry sleep. */
  onRetry?: (event: RegistryRetryEvent) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRegistrySubmitter(options: RegistrySubmitterOptions): AttestationSubmitter {
  const servers = new Map<string, rpc.Server>();
  const sleep = options.sleep ?? defaultSleep;
  const pick = (): NonNullable<RegistrySubmitterOptions["server"]> => {
    if (options.server) return options.server;
    const url = options.rpcPool?.current() ?? options.rpcUrl;
    let server = servers.get(url);
    if (!server) {
      server = new rpc.Server(url);
      servers.set(url, server);
    }
    return server;
  };
  const keypair = Keypair.fromSecret(options.attestorSecretKey);
  const registry = new Contract(options.registryContractId);

  async function invokeOnce(
    server: NonNullable<RegistrySubmitterOptions["server"]>,
    method: string,
    args: import("@stellar/stellar-sdk").xdr.ScVal[],
  ) {
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: options.networkPassphrase,
    })
      .addOperation(registry.call(method, ...args))
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "TRY_AGAIN_LATER") {
      throw new RegistrySubmissionError(
        `registry ${method} submission busy: TRY_AGAIN_LATER`,
        "registry_transient",
      );
    }
    if (sent.status === "ERROR") {
      const serializedError = JSON.stringify(sent.errorResult ?? "");
      const message = `registry ${method} submission rejected: ${serializedError}`;
      const detectedClass = classifyRegistrySubmissionError(message);
      throw new RegistrySubmissionError(
        message,
        detectedClass === "terminal" ? "terminal" : detectedClass,
      );
    }

    for (let i = 0; i < 30; i++) {
      const result = await server.getTransaction(sent.hash);
      if (result.status === "SUCCESS") return;
      if (result.status === "FAILED") {
        throw new RegistrySubmissionError(
          `registry ${method} failed on-chain (tx ${sent.hash})`,
          "terminal",
        );
      }
      await sleep(1000);
    }
    throw new RegistrySubmissionError(
      `registry ${method} not final after 30s (tx ${sent.hash})`,
      "generic_transient",
    );
  }

  async function invoke(method: string, args: import("@stellar/stellar-sdk").xdr.ScVal[]) {
    const server = pick();
    const attemptsByClass: Record<Exclude<RegistrySubmissionErrorClass, "terminal">, number> = {
      registry_transient: 0,
      generic_transient: 0,
    };

    for (;;) {
      try {
        await invokeOnce(server, method, args);
        return;
      } catch (err) {
        const errorClass = classifyRegistrySubmissionError(err);
        if (errorClass === "terminal") {
          throw err;
        }
        const policy = resolveBackoffPolicy(errorClass, options.backoff);
        const nextAttempt = attemptsByClass[errorClass] + 1;
        if (nextAttempt > policy.maxRetries) {
          throw err;
        }
        attemptsByClass[errorClass] = nextAttempt;
        const delayMs = computeBackoffDelayMs(errorClass, nextAttempt, options.backoff);
        options.onRetry?.({
          method,
          attempt: nextAttempt,
          errorClass,
          delayMs,
          error: err,
        });
        await sleep(delayMs);
      }
    }
  }

  async function simulateRead(method: string, args: import("@stellar/stellar-sdk").xdr.ScVal[]) {
    const server = pick();
    const account = await server.getAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: options.networkPassphrase,
    })
      .addOperation(registry.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`registry ${method} simulation failed`);
    }
    return sim.result?.retval;
  }

  return {
    async upsert(contractId, wasmHashHex, expiresLedger) {
      const hash = Buffer.from(wasmHashHex, "hex");
      if (hash.length !== 32) {
        throw new Error(`attested wasm hash must be 32 bytes, got ${hash.length}`);
      }
      await invoke("upsert", [
        nativeToScVal(contractId, { type: "address" }),
        nativeToScVal(hash, { type: "bytes" }),
        nativeToScVal(expiresLedger, { type: "u32" }),
      ]);
    },

    async upsertWithPublisher(contractId, wasmHashHex, publisherIdHex, expiresLedger) {
      const hash = Buffer.from(wasmHashHex, "hex");
      if (hash.length !== 32) {
        throw new Error(`attested wasm hash must be 32 bytes, got ${hash.length}`);
      }
      const publisher = Buffer.from(publisherIdHex, "hex");
      if (publisher.length !== 32) {
        throw new Error(`publisher id must be 32 bytes, got ${publisher.length}`);
      }
      await invoke("upsert_with_publisher", [
        nativeToScVal(contractId, { type: "address" }),
        nativeToScVal(hash, { type: "bytes" }),
        nativeToScVal(publisher, { type: "bytes" }),
        nativeToScVal(expiresLedger, { type: "u32" }),
      ]);
    },

    async revoke(contractId) {
      await invoke("revoke", [nativeToScVal(contractId, { type: "address" })]);
    },

    async isAttested(contractId) {
      const retval = await simulateRead("attestation", [
        nativeToScVal(contractId, { type: "address" }),
      ]);
      if (!retval) return false;
      const native = scValToNative(retval);
      return native !== null && native !== undefined;
    },

    async currentLedger() {
      const server = pick();
      const latest = await server.getLatestLedger();
      return latest.sequence;
    },
  };
}
