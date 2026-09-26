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
}

export function createRegistrySubmitter(options: RegistrySubmitterOptions): AttestationSubmitter {
  const servers = new Map<string, rpc.Server>();
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

  async function invoke(method: string, args: import("@stellar/stellar-sdk").xdr.ScVal[]) {
    const server = pick();
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
    if (sent.status === "ERROR") {
      throw new Error(
        `registry ${method} submission rejected: ${JSON.stringify(sent.errorResult)}`,
      );
    }

    for (let i = 0; i < 30; i++) {
      const result = await server.getTransaction(sent.hash);
      if (result.status === "SUCCESS") return;
      if (result.status === "FAILED") {
        throw new Error(`registry ${method} failed on-chain (tx ${sent.hash})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`registry ${method} not final after 30s (tx ${sent.hash})`);
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
