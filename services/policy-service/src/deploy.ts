import { randomBytes } from "node:crypto";
import {
  Address,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// Server-side deploy of a per-user spending-limit policy instance.
//
// Two-step attach (docs/decisions.md 2026-07-17):
//   1. THIS module deploys a configured contract instance from the policy
//      wasm hash, bound to the user's smart-account, funded by the sponsor.
//      No passkey needed — the instance is not yet a signer on the wallet.
//   2. The web app passkey-signs `kit.addPolicy(contractId, …)`, which runs
//      the contract's `install` hook (asserts wallet == the bound wallet).
//
// The contract's `__constructor(wallet, daily_limit, window_seconds)` sets the
// immutable cap. `install` and `policy__` both reject any wallet other than
// `wallet`, so binding here is what makes the instance single-tenant.
//
// Structural seams (an injected clock/rpc are unnecessary here; the rpc.Server
// is the only external dependency) mirror wallet-service/sponsor.ts.

export class PolicyDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PolicyDeployError";
  }
}

export interface PolicyDeployConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Testnet fee-sponsor secret — deploys and funds the instance. */
  sponsorSecretKey: string;
}

export interface DeployPolicyInstanceInput {
  /** The user's smart-account (C…) the instance is bound to. */
  wallet: string;
  /** Cumulative window allowance in stroops (string to preserve i128 range). */
  dailyLimitStroops: string;
  /** Rolling-window length in seconds. */
  windowSeconds: number;
}

export interface SimulateResult {
  ok: boolean;
  /** Estimated min resource fee in stroops (from simulation), when available. */
  minResourceFee?: string;
  /** Present when ok is false: why the deploy would fail. */
  error?: string;
}

export interface PolicyDeployer {
  /** Dry-run: build + simulate the deploy without submitting. Surfaces
   * constructor guard failures (bad limit/window) before the user commits. */
  simulateInstance(input: DeployPolicyInstanceInput): Promise<SimulateResult>;
  deployInstance(input: DeployPolicyInstanceInput): Promise<{ contractId: string; txHash: string }>;
}

// Max fee for the deploy (stroops). Deploys upload no code (the wasm is already
// installed) but do run the constructor; generous to avoid fee-bump churn.
const DEPLOY_FEE = "10000000";
// The relayer/testnet reject timebounds more than 60s out; we submit direct to
// RPC here but keep the same ceiling for consistency (sponsor.ts).
const TIMEOUT_SECONDS = 60;

export function createPolicyDeployer(
  config: PolicyDeployConfig,
  wasmHashHex: string,
): PolicyDeployer {
  const server = new rpc.Server(config.rpcUrl);
  const sponsor = Keypair.fromSecret(config.sponsorSecretKey);
  const wasmHash = Buffer.from(wasmHashHex, "hex");

  // Builds the (unsigned) deploy tx for the given input. Shared by simulate
  // and deploy so both exercise the exact same createContract + constructor.
  async function buildDeployTx(input: DeployPolicyInstanceInput): Promise<Transaction> {
    let source;
    try {
      source = await server.getAccount(sponsor.publicKey());
    } catch (err) {
      throw new PolicyDeployError(
        `Sponsor account load failed: ${err instanceof Error ? err.message : String(err)}`,
        "sponsor_load_failed",
      );
    }

    // __constructor(wallet: Address, daily_limit: i128, window_seconds: u64)
    const constructorArgs = [
      nativeToScVal(Address.fromString(input.wallet), { type: "address" }),
      nativeToScVal(BigInt(input.dailyLimitStroops), { type: "i128" }),
      nativeToScVal(input.windowSeconds, { type: "u64" }),
    ];

    return new TransactionBuilder(source, {
      fee: DEPLOY_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.createCustomContract({
          address: Address.fromString(sponsor.publicKey()),
          wasmHash,
          constructorArgs,
          salt: randomBytes(32),
        }),
      )
      .setTimeout(TIMEOUT_SECONDS)
      .build();
  }

  return {
    async simulateInstance(input) {
      let built: Transaction;
      try {
        built = await buildDeployTx(input);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const sim = await server.simulateTransaction(built);
      if (rpc.Api.isSimulationError(sim)) {
        return { ok: false, error: sim.error };
      }
      return { ok: true, minResourceFee: sim.minResourceFee };
    },

    async deployInstance(input) {
      const built = await buildDeployTx(input);

      let prepared: Transaction;
      try {
        prepared = (await server.prepareTransaction(built)) as Transaction;
      } catch (err) {
        // Constructor guards (invalid limit/window) surface here, before submit.
        throw new PolicyDeployError(
          `Policy deploy simulation failed: ${err instanceof Error ? err.message : String(err)}`,
          "deploy_simulation_failed",
        );
      }
      prepared.sign(sponsor);

      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new PolicyDeployError(
          `Policy deploy submission failed: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
          "deploy_submit_failed",
        );
      }

      const deadline = Date.now() + TIMEOUT_SECONDS * 1000;
      for (;;) {
        const status = await server.getTransaction(sent.hash);
        if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          const contractId = extractContractId(status);
          if (!contractId) {
            throw new PolicyDeployError(
              "Policy deployed but contract id could not be read from the result",
              "deploy_no_contract_id",
            );
          }
          return { contractId, txHash: sent.hash };
        }
        if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new PolicyDeployError(
            `Policy deploy failed on-chain: ${sent.hash}`,
            "deploy_failed",
          );
        }
        if (Date.now() > deadline) {
          throw new PolicyDeployError(
            `Policy deploy still pending: ${sent.hash}`,
            "deploy_timeout",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  };
}

/** The createContract host function returns the new contract's address as its
 * result value; read it back rather than re-deriving from (deployer, salt). */
function extractContractId(status: rpc.Api.GetSuccessfulTransactionResponse): string | undefined {
  const value = status.returnValue;
  if (!value) return undefined;
  try {
    const native = scValToNative(value);
    if (typeof native === "string" && native.startsWith("C")) return native;
    // Some SDK versions return an Address instance.
    if (native && typeof native.toString === "function") {
      const s = native.toString();
      if (s.startsWith("C")) return s;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
