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
  xdr,
} from "@stellar/stellar-sdk";
import type { SpendingConstructor, VerifiedRecipientConstructor } from "./templates";

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

/** Sentinel error thrown internally by `withTimeoutError`'s own race timer.
 * Never escapes this module — `withTimeoutError` always translates it into
 * a `PolicyDeployError` with code `"deploy_rpc_timeout"` before rethrowing.
 *
 * This is a deliberate, self-implemented timeout rather than a reliance on
 * `rpc.Server`'s constructor `timeout` option: as of `@stellar/stellar-sdk`
 * 16.0.1, that option is silently dropped — `RpcServer`'s constructor calls
 * `createHttpClient(opts.headers)`, which accepts only `headers` and never
 * receives `opts.timeout` at all (confirmed by reading `rpc/axios.js`; the
 * option is present in the TS types but has no effect on the underlying
 * fetch client). Verified experimentally too: a `getAccount()` call against
 * a deliberately non-responding local server hung well past the configured
 * `timeout`, which is what surfaced this. Do not remove this wrapper under
 * the assumption `rpc.Server`'s own option covers it — re-check this
 * comment against the installed SDK version before doing so (#327).
 */
class RpcTimeoutSentinel extends Error {}

/** Races `fn()` against a `timeoutMs` timer implemented in this module
 * (see `RpcTimeoutSentinel`'s comment for why `rpc.Server`'s own `timeout`
 * option isn't relied on) — a real per-call timeout budget for every RPC
 * call in the deploy path, per #327. On timeout, throws a
 * `PolicyDeployError` with code `"deploy_rpc_timeout"`. Every other failure
 * from `fn` passes through to `onOtherError` unchanged, so this never masks
 * a real RPC/contract failure as a timeout. */
async function withTimeoutError<T>(
  step: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  onOtherError: (err: unknown) => never,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RpcTimeoutSentinel(step)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    if (err instanceof RpcTimeoutSentinel) {
      throw new PolicyDeployError(
        `Policy deploy RPC call timed out: ${step}`,
        "deploy_rpc_timeout",
      );
    }
    onOtherError(err);
  } finally {
    clearTimeout(timer);
  }
}

export interface PolicyDeployConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Testnet fee-sponsor secret — deploys and funds the instance. */
  sponsorSecretKey: string;
  /** Per-HTTP-request timeout (ms) for every RPC call in the deploy path
   * (getAccount, simulateTransaction, prepareTransaction, sendTransaction).
   * Passed straight to `rpc.Server`'s own `timeout` option (#327). A network
   * stall on any one of these calls fails with `PolicyDeployError` code
   * `"deploy_rpc_timeout"` instead of hanging indefinitely. */
  rpcTimeoutMs: number;
  /** Overall budget (ms) for `deployInstance`'s post-submission polling
   * loop (#327) — distinct from `rpcTimeoutMs`, which bounds each
   * individual HTTP call rather than the loop as a whole. */
  pollTimeoutMs: number;
  /** Test-only escape hatch: `rpc.Server` refuses a non-`https://` URL
   * unless this is set, even for `127.0.0.1` — real deployments always use
   * a real `https://` RPC endpoint, so this should never be set outside
   * tests exercising the RPC layer against a local fake server. */
  allowHttp?: boolean;
}

export interface DeployPolicyInstanceInput {
  /** The user's smart-account (C…) the instance is bound to. */
  wallet: string;
  /** Template-specific constructor args from the generated manifest:
   * spending-limit → { dailyLimitStroops, windowSeconds };
   * verified-recipient → { registry }. The wallet is always arg 0. */
  constructorArgs: SpendingConstructor | VerifiedRecipientConstructor;
}

/** ScVals for the template's `__constructor`, discriminated by args shape. */
function constructorScVals(input: DeployPolicyInstanceInput): xdr.ScVal[] {
  const wallet = nativeToScVal(Address.fromString(input.wallet), { type: "address" });
  if ("registry" in input.constructorArgs) {
    // __constructor(wallet: Address, registry: Address)
    return [
      wallet,
      nativeToScVal(Address.fromString(input.constructorArgs.registry), { type: "address" }),
    ];
  }
  // __constructor(wallet: Address, daily_limit: i128, window_seconds: u64)
  return [
    wallet,
    nativeToScVal(BigInt(input.constructorArgs.dailyLimitStroops), { type: "i128" }),
    nativeToScVal(input.constructorArgs.windowSeconds, { type: "u64" }),
  ];
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
export const DEPLOY_FEE = "10000000";
// The relayer/testnet reject timebounds more than 60s out; we submit direct to
// RPC here but keep the same ceiling for consistency (sponsor.ts).
const TIMEOUT_SECONDS = 60;

export function createPolicyDeployer(
  config: PolicyDeployConfig,
  wasmHashHex: string,
): PolicyDeployer {
  // #327: config.rpcTimeoutMs is enforced by withTimeoutError below, not by
  // rpc.Server itself — see RpcTimeoutSentinel's comment for why.
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
  const sponsor = Keypair.fromSecret(config.sponsorSecretKey);
  const wasmHash = Buffer.from(wasmHashHex, "hex");

  // Builds the (unsigned) deploy tx for the given input. Shared by simulate
  // and deploy so both exercise the exact same createContract + constructor.
  async function buildDeployTx(input: DeployPolicyInstanceInput): Promise<Transaction> {
    const source = await withTimeoutError(
      "getAccount",
      config.rpcTimeoutMs,
      () => server.getAccount(sponsor.publicKey()),
      (err) => {
        throw new PolicyDeployError(
          `Sponsor account load failed: ${err instanceof Error ? err.message : String(err)}`,
          "sponsor_load_failed",
        );
      },
    );

    const constructorArgs = constructorScVals(input);

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
      const sim = await withTimeoutError(
        "simulateTransaction",
        config.rpcTimeoutMs,
        () => server.simulateTransaction(built),
        (err) => {
          throw new PolicyDeployError(
            `Policy deploy simulation RPC failed: ${err instanceof Error ? err.message : String(err)}`,
            "deploy_simulation_rpc_failed",
          );
        },
      );
      if (rpc.Api.isSimulationError(sim)) {
        return { ok: false, error: sim.error };
      }
      return { ok: true, minResourceFee: sim.minResourceFee };
    },

    async deployInstance(input) {
      const built = await buildDeployTx(input);

      const prepared = (await withTimeoutError(
        "prepareTransaction",
        config.rpcTimeoutMs,
        () => server.prepareTransaction(built),
        (err) => {
          // Constructor guards (invalid limit/window) surface here, before submit.
          throw new PolicyDeployError(
            `Policy deploy simulation failed: ${err instanceof Error ? err.message : String(err)}`,
            "deploy_simulation_failed",
          );
        },
      )) as Transaction;
      prepared.sign(sponsor);

      const sent = await withTimeoutError(
        "sendTransaction",
        config.rpcTimeoutMs,
        () => server.sendTransaction(prepared),
        (err) => {
          throw new PolicyDeployError(
            `Policy deploy submission RPC failed: ${err instanceof Error ? err.message : String(err)}`,
            "deploy_submit_rpc_failed",
          );
        },
      );
      if (sent.status === "ERROR") {
        throw new PolicyDeployError(
          `Policy deploy submission failed: ${sent.errorResult?.toXDR("base64") ?? "unknown"}`,
          "deploy_submit_failed",
        );
      }

      const deadline = Date.now() + config.pollTimeoutMs;
      for (;;) {
        const status = await withTimeoutError(
          "getTransaction",
          config.rpcTimeoutMs,
          () => server.getTransaction(sent.hash),
          (err) => {
            throw new PolicyDeployError(
              `Policy deploy status RPC failed: ${err instanceof Error ? err.message : String(err)}`,
              "deploy_status_rpc_failed",
            );
          },
        );
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
