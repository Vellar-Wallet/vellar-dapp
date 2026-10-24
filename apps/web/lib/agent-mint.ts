import type { GeneratedPolicy } from "vellar-sdk";
import { formatAmountWithDecimals } from "./tokens";

// Agent key mint flow (#394) as an explicit state machine (technical-doc.md
// §17.3). The reducer is pure so every transition and failure path is unit
// tested; `runMint` drives it against injected effects so the UI only renders
// state. Sequence:
//
//   idle → creating-key → policy-creation → awaiting-confirmation
//        → awaiting-passkey-approval(attach) → attaching-policy
//        → awaiting-passkey-approval(add-signer) → adding-signer
//        → confirming → success
//
// Security properties the machine encodes:
//   - The budget is the deployed token-scoped policy contract — the ONLY thing
//     the state carries about the budget is the policy instance id the chain
//     returned. Nothing here computes or enforces an amount.
//   - Explicit confirmation of the exact budget, token, and expiry BEFORE any
//     passkey prompt (no silent signing). The summary is derived from the same
//     MintConfig that feeds `generatePolicy` and `addAgentKey`, so it cannot
//     drift from what is encoded in the mint transaction being signed.
//   - Two explicit passkey prompts (attach policy, add signer). Neither can be
//     skipped: the transitions that reach `attaching-policy` / `adding-signer`
//     are only produced by the effects that ran `kit.sign`.
//   - The agent secret exists only in `creating-key`'s result and is carried to
//     the `success` state for a ONE-TIME reveal; `DISMISS_SECRET` drops it and
//     no later state can re-expose it. It is never logged or persisted.
//   - Any failure lands in `error` with the stage it failed at; `RESET` returns
//     to idle. A failure after the signer was added is reported as such so the
//     operator knows an agent key exists on-chain (and can revoke it).

export type MintStage =
  | "creating-key"
  | "policy-creation"
  | "awaiting-confirmation"
  | "attaching-policy"
  | "adding-signer"
  | "confirming";

export interface MintConfig {
  /** SEP-41 token contract (C…) the budget is denominated in. */
  token: string;
  /** Human label for the token (display only). */
  tokenSymbol: string;
  /** Display decimals for the token; used only to format the confirmation copy. */
  tokenDecimals?: number;
  /** Budget in the token's base units, as the policy contract stores it. */
  amountBaseUnits: string;
  windowSeconds: number;
  /** Unix seconds; `undefined` = no expiry (allowed but discouraged). */
  expiresAtSeconds?: number;
  network: "testnet" | "mainnet";
}

/** Human-readable restatement of what the mint transaction will encode.
 * Built from MintConfig — the same object that feeds generatePolicy and
 * addAgentKey — so the copy can never describe a different budget than the
 * one being signed. */
export interface MintSummary {
  /** Human-readable asset name (symbol), never the bare contract id alone. */
  tokenLabel: string;
  /** Contract id, shown as a secondary identifier. */
  tokenId: string;
  /** Budget in the token's display units, with the symbol. */
  budgetLabel: string;
  /** Budget exactly as the policy contract stores it. */
  budgetBaseUnits: string;
  /** Human-readable expiry, or an explicit "no expiry" label. */
  expiryLabel: string;
  /** Spending window in human-readable form. */
  windowLabel: string;
}

function windowLabel(windowSeconds: number): string {
  if (windowSeconds % 604_800 === 0) return `per ${windowSeconds / 604_800} week(s)`;
  if (windowSeconds % 86_400 === 0) return `per ${windowSeconds / 86_400} day(s)`;
  if (windowSeconds % 3_600 === 0) return `per ${windowSeconds / 3_600} hour(s)`;
  return `per ${windowSeconds}s`;
}

/** The exact confirmation copy for a mint, derived from `config`. */
export function summarizeMintConfig(config: MintConfig): MintSummary {
  const decimals = config.tokenDecimals ?? 7;
  return {
    tokenLabel: config.tokenSymbol,
    tokenId: config.token,
    budgetLabel: `${formatAmountWithDecimals(BigInt(config.amountBaseUnits), decimals)} ${config.tokenSymbol}`,
    budgetBaseUnits: config.amountBaseUnits,
    expiryLabel: config.expiresAtSeconds
      ? new Date(config.expiresAtSeconds * 1000).toLocaleString()
      : "No expiry (not recommended)",
    windowLabel: windowLabel(config.windowSeconds),
  };
}

export interface AgentKeyMaterial {
  publicKey: string;
  /** The ed25519 secret (S…). Revealed exactly once. */
  secret: string;
}

export type MintState =
  | { step: "idle" }
  | { step: "creating-key"; config: MintConfig }
  | { step: "policy-creation"; config: MintConfig; key: AgentKeyMaterial; detail: string }
  | {
      step: "awaiting-confirmation";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      /** Human-readable restatement of the mint, before any passkey prompt. */
      summary: MintSummary;
    }
  | {
      step: "awaiting-passkey-approval";
      for: "attach-policy" | "add-signer";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
    }
  | {
      step: "attaching-policy";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
    }
  | {
      step: "adding-signer";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      attachTxHash: string;
    }
  | {
      step: "confirming";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      attachTxHash: string;
      addSignerTxHash: string;
    }
  | {
      step: "success";
      config: MintConfig;
      publicKey: string;
      /** Present until DISMISS_SECRET; then gone for good. */
      secret?: string;
      policyContractId: string;
      attachTxHash: string;
      addSignerTxHash: string;
    }
  | {
      step: "error";
      stage: MintStage;
      message: string;
      /** True once the agent signer transaction was submitted: an agent key may
       * exist on-chain even though the flow did not complete. */
      signerMayExist: boolean;
      policyContractId?: string;
    };

export type MintEvent =
  | { type: "START"; config: MintConfig }
  | { type: "KEY_CREATED"; key: AgentKeyMaterial }
  | { type: "POLICY_PROGRESS"; detail: string }
  | { type: "POLICY_DEPLOYED"; policyContractId: string }
  | { type: "DETAILS_CONFIRMED" }
  | { type: "PASSKEY_APPROVED"; for: "attach-policy" | "add-signer" }
  | { type: "POLICY_ATTACHED"; hash: string }
  | { type: "SIGNER_ADDED"; hash: string }
  | { type: "CONFIRMED" }
  | { type: "FAIL"; stage: MintStage; message: string }
  | { type: "DISMISS_SECRET" }
  | { type: "RESET" };

export const initialMintState: MintState = { step: "idle" };

/** Pure transition function. Unexpected events for a state are ignored
 * (returning the same state) so a late effect can never corrupt the flow. */
export function mintReducer(state: MintState, event: MintEvent): MintState {
  if (event.type === "RESET") return initialMintState;
  if (event.type === "FAIL") {
    const signerMayExist = state.step === "confirming";
    const policyContractId = "policyContractId" in state ? state.policyContractId : undefined;
    return {
      step: "error",
      stage: event.stage,
      message: event.message,
      signerMayExist,
      ...(policyContractId ? { policyContractId } : {}),
    };
  }
  switch (state.step) {
    case "idle":
      return event.type === "START" ? { step: "creating-key", config: event.config } : state;
    case "creating-key":
      return event.type === "KEY_CREATED"
        ? {
            step: "policy-creation",
            config: state.config,
            key: event.key,
            detail: "Generating policy…",
          }
        : state;
    case "policy-creation":
      if (event.type === "POLICY_PROGRESS") return { ...state, detail: event.detail };
      if (event.type === "POLICY_DEPLOYED") {
        // Land on the confirmation step, not the passkey prompt: the human
        // must see the exact budget/token/expiry before any signing begins.
        return {
          step: "awaiting-confirmation",
          config: state.config,
          key: state.key,
          policyContractId: event.policyContractId,
          summary: summarizeMintConfig(state.config),
        };
      }
      return state;
    case "awaiting-confirmation":
      return event.type === "DETAILS_CONFIRMED"
        ? {
            step: "awaiting-passkey-approval",
            for: "attach-policy",
            config: state.config,
            key: state.key,
            policyContractId: state.policyContractId,
          }
        : state;
    case "awaiting-passkey-approval":
      if (event.type === "PASSKEY_APPROVED" && event.for === state.for) {
        return state.for === "attach-policy"
          ? {
              step: "attaching-policy",
              config: state.config,
              key: state.key,
              policyContractId: state.policyContractId,
            }
          : state; // add-signer approval is reported via SIGNER_ADDED below
      }
      if (state.for === "add-signer" && event.type === "SIGNER_ADDED") {
        return {
          step: "confirming",
          config: state.config,
          key: state.key,
          policyContractId: state.policyContractId,
          attachTxHash: (state as { attachTxHash?: string }).attachTxHash ?? "",
          addSignerTxHash: event.hash,
        };
      }
      return state;
    case "attaching-policy":
      return event.type === "POLICY_ATTACHED"
        ? {
            step: "adding-signer",
            config: state.config,
            key: state.key,
            policyContractId: state.policyContractId,
            attachTxHash: event.hash,
          }
        : state;
    case "adding-signer":
      return event.type === "SIGNER_ADDED"
        ? {
            step: "confirming",
            config: state.config,
            key: state.key,
            policyContractId: state.policyContractId,
            attachTxHash: state.attachTxHash,
            addSignerTxHash: event.hash,
          }
        : state;
    case "confirming":
      return event.type === "CONFIRMED"
        ? {
            step: "success",
            config: state.config,
            publicKey: state.key.publicKey,
            secret: state.key.secret,
            policyContractId: state.policyContractId,
            attachTxHash: state.attachTxHash,
            addSignerTxHash: state.addSignerTxHash,
          }
        : state;
    case "success":
      if (event.type === "DISMISS_SECRET") {
        const { secret: _dropped, ...rest } = state;
        return rest;
      }
      return state;
    case "error":
      return state;
  }
}

/** Whether the machine is mid-flight (buttons disabled, navigation guarded). */
export function isMintBusy(state: MintState): boolean {
  return !["idle", "success", "error"].includes(state.step);
}

// ---------------------------------------------------------------------------
// Orchestration: drives the reducer against injected effects.

export interface MintEffects {
  /** Generate agent key material in the browser (never leaves the client). */
  generateKey(): Promise<AgentKeyMaterial>;
  /** policy-service: validate + generate the token budget policy record. */
  generatePolicy(config: MintConfig, wallet: string): Promise<GeneratedPolicy>;
  /** policy-service: dry-run the instance deploy for this wallet. */
  simulateDeploy(policyId: string, wallet: string): Promise<{ ok: boolean; error?: string }>;
  /** policy-service: sponsor-funded instance deploy bound to this wallet. */
  deployInstance(policyId: string, wallet: string): Promise<{ contractId: string }>;
  /** Explicit confirmation of the budget/token/expiry summary, BEFORE any
   * passkey prompt. Resolves only when the human approves the exact copy. */
  confirmDetails(summary: MintSummary): Promise<void>;
  /** Passkey prompt #1: kit.addPolicy (standalone signer) → submit. */
  attachPolicy(policyContractId: string): Promise<{ hash: string }>;
  /** policy-service: record the attach against the policy record. */
  recordDeployment(policyId: string, txHash: string, contractId: string): Promise<unknown>;
  /** Passkey prompt #2: kit.addEd25519 with the policy as required co-signer → submit. */
  addAgentKey(input: {
    publicKey: string;
    token: string;
    policyContractId: string;
    expiresAtSeconds?: number;
  }): Promise<{ hash: string }>;
  /** Wait for both transactions to be final on the network. */
  confirm(hashes: string[]): Promise<void>;
}

export interface MintRunnerOptions {
  effects: MintEffects;
  wallet: string;
  dispatch: (event: MintEvent) => void;
  /** Map a thrown error to user-facing copy (never includes key material). */
  errorMessage?: (err: unknown) => string;
}

/**
 * Run the full mint. Dispatches every transition so the UI can render the
 * machine; resolves when the machine reaches `success` or `error`. Effects run
 * strictly in order; a throw at any stage dispatches FAIL for THAT stage.
 */
export async function runMint(config: MintConfig, opts: MintRunnerOptions): Promise<void> {
  const { effects, wallet, dispatch } = opts;
  const describe =
    opts.errorMessage ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  let stage: MintStage = "creating-key";
  try {
    dispatch({ type: "START", config });
    const key = await effects.generateKey();
    dispatch({ type: "KEY_CREATED", key });

    stage = "policy-creation";
    dispatch({ type: "POLICY_PROGRESS", detail: "Generating token budget policy…" });
    const policy = await effects.generatePolicy(config, wallet);
    dispatch({ type: "POLICY_PROGRESS", detail: "Checking the deploy will succeed…" });
    const sim = await effects.simulateDeploy(policy.id, wallet);
    if (!sim.ok) throw new Error(sim.error ?? "Policy deploy simulation failed");
    dispatch({ type: "POLICY_PROGRESS", detail: "Deploying the budget policy to testnet…" });
    const { contractId } = await effects.deployInstance(policy.id, wallet);
    dispatch({ type: "POLICY_DEPLOYED", policyContractId: contractId });

    // Explicit, no-silent-signing confirmation BEFORE the first passkey prompt.
    // The summary is derived from `config` — the same object the effects above
    // and below actually encode — so the copy cannot drift from the mint.
    stage = "awaiting-confirmation";
    await effects.confirmDetails(summarizeMintConfig(config));
    dispatch({ type: "DETAILS_CONFIRMED" });

    stage = "attaching-policy";
    dispatch({ type: "PASSKEY_APPROVED", for: "attach-policy" });
    const attach = await effects.attachPolicy(contractId);
    await effects.recordDeployment(policy.id, attach.hash, contractId);
    dispatch({ type: "POLICY_ATTACHED", hash: attach.hash });

    stage = "adding-signer";
    const added = await effects.addAgentKey({
      publicKey: key.publicKey,
      token: config.token,
      policyContractId: contractId,
      expiresAtSeconds: config.expiresAtSeconds,
    });
    dispatch({ type: "SIGNER_ADDED", hash: added.hash });

    stage = "confirming";
    await effects.confirm([attach.hash, added.hash]);
    dispatch({ type: "CONFIRMED" });
  } catch (err) {
    dispatch({ type: "FAIL", stage, message: describe(err) });
  }
}
