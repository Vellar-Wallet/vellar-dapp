import type { GeneratedPolicy } from "vellar-sdk";
import { findToken, formatAmountWithDecimals } from "./tokens";

// Agent key mint flow (#394) as an explicit state machine (technical-doc.md
// §17.3). The reducer is pure so every transition and failure path is unit
// tested; `runMint` drives it against injected effects so the UI only renders
// state. Sequence:
//
//   idle → creating-key → policy-creation → awaiting-passkey-approval(attach)
//        → attaching-policy → awaiting-passkey-approval(add-signer)
//        → adding-signer → confirming → success
//
// Security properties the machine encodes:
//   - The budget is the deployed token-scoped policy contract — the ONLY thing
//     the state carries about the budget is the policy instance id the chain
//     returned. Nothing here computes or enforces an amount.
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
  "creating-key" | "policy-creation" | "attaching-policy" | "adding-signer" | "confirming";

export interface MintConfig {
  /** SEP-41 token contract (C…) the budget is denominated in. */
  token: string;
  /** Human label for the token (display only). */
  tokenSymbol: string;
  /** Optional human-readable asset name (e.g. "Stellar Lumens", "USD Coin"). */
  tokenName?: string;
  /** Optional token decimal places (defaults to registry decimals or 7). */
  tokenDecimals?: number;
  /** Budget in the token's base units, as the policy contract stores it. */
  amountBaseUnits: string;
  windowSeconds: number;
  /** Unix seconds; `undefined` = no expiry (allowed but discouraged). */
  expiresAtSeconds?: number;
  network: "testnet" | "mainnet";
}

export interface MintConfirmationSummary {
  /** Human-readable asset name (e.g. "Stellar Lumens", "USD Coin"), never just a contract ID. */
  tokenName: string;
  /** Token ticker symbol (e.g. "XLM", "USDC"). */
  tokenSymbol: string;
  /** Combined human-readable asset label (e.g. "Stellar Lumens (XLM)"). */
  tokenDisplay: string;
  /** Exact SEP-41 token contract ID encoded in the policy and signer grant. */
  tokenContractId: string;
  /** Exact budget in base units encoded in the token_spending_limit policy. */
  amountBaseUnits: string;
  /** Human-readable decimal budget amount (e.g. "10"). */
  budgetAmount: string;
  /** Exact window duration in seconds encoded in the policy. */
  windowSeconds: number;
  /** Human-readable window label (e.g. "per 24 hours"). */
  windowDisplay: string;
  /** Combined human-readable budget summary (e.g. "10 XLM per 24 hours"). */
  budgetDisplay: string;
  /** Exact Unix timestamp in seconds passed to addAgentKey, or undefined if no expiry. */
  expiresAtSeconds?: number;
  /** ISO-8601 UTC timestamp for expiry, or null when no expiry is set. */
  expiresAtIso: string | null;
  /** Human-readable expiry label (ISO UTC string or "No expiry"). */
  expiryDisplay: string;
  /** Target network ("testnet" | "mainnet"). */
  network: "testnet" | "mainnet";
  /** Deployed budget policy contract ID, populated once deployed before passkey approval. */
  policyContractId?: string;
  /** Generated agent public key (G…), populated once created before passkey approval. */
  agentPublicKey?: string;
}

const KNOWN_ASSET_NAMES: Record<string, string> = {
  XLM: "Stellar Lumens",
  USDC: "USD Coin",
  EURC: "Euro Coin",
};

function formatWindowLabel(windowSeconds: number): string {
  if (windowSeconds === 3600) return "per hour";
  if (windowSeconds === 86_400) return "per 24 hours";
  if (windowSeconds === 604_800) return "per 7 days";
  if (windowSeconds % 86_400 === 0) return `per ${windowSeconds / 86_400} days`;
  if (windowSeconds % 3600 === 0) return `per ${windowSeconds / 3600} hours`;
  return `per ${windowSeconds} seconds`;
}

/**
 * Build the user-facing confirmation summary directly from the authoritative
 * `MintConfig` that is encoded into the budget policy and `addAgentKey` call.
 * Resolves the human-readable asset name so the summary never displays a raw
 * contract ID alone.
 */
export function buildMintConfirmationSummary(
  config: MintConfig,
  context?: { policyContractId?: string; agentPublicKey?: string },
): MintConfirmationSummary {
  const byContract = findToken(config.network, config.token);
  const bySymbol = config.tokenSymbol ? findToken(config.network, config.tokenSymbol) : undefined;
  const registryToken = byContract ?? bySymbol;

  const symbol = (config.tokenSymbol || registryToken?.symbol || "TOKEN").trim();
  const resolvedName =
    config.tokenName?.trim() ||
    registryToken?.name ||
    KNOWN_ASSET_NAMES[symbol.toUpperCase()] ||
    `${symbol} Token`;
  const decimals = config.tokenDecimals ?? registryToken?.decimals ?? 7;

  const budgetAmount = formatAmountWithDecimals(BigInt(config.amountBaseUnits), decimals);
  const windowDisplay = formatWindowLabel(config.windowSeconds);
  const budgetDisplay = `${budgetAmount} ${symbol} ${windowDisplay}`;
  const tokenDisplay = `${resolvedName} (${symbol})`;

  const expiresAtIso =
    config.expiresAtSeconds !== undefined
      ? new Date(config.expiresAtSeconds * 1000).toISOString()
      : null;
  const expiryDisplay = expiresAtIso ?? "No expiry";

  return {
    tokenName: resolvedName,
    tokenSymbol: symbol,
    tokenDisplay,
    tokenContractId: config.token,
    amountBaseUnits: config.amountBaseUnits,
    budgetAmount,
    windowSeconds: config.windowSeconds,
    windowDisplay,
    budgetDisplay,
    ...(config.expiresAtSeconds !== undefined ? { expiresAtSeconds: config.expiresAtSeconds } : {}),
    expiresAtIso,
    expiryDisplay,
    network: config.network,
    ...(context?.policyContractId ? { policyContractId: context.policyContractId } : {}),
    ...(context?.agentPublicKey ? { agentPublicKey: context.agentPublicKey } : {}),
  };
}

export interface AgentKeyMaterial {
  publicKey: string;
  /** The ed25519 secret (S…). Revealed exactly once. */
  secret: string;
}

export type MintState =
  | { step: "idle" }
  | { step: "creating-key"; config: MintConfig; summary: MintConfirmationSummary }
  | {
      step: "policy-creation";
      config: MintConfig;
      key: AgentKeyMaterial;
      detail: string;
      summary: MintConfirmationSummary;
    }
  | {
      step: "awaiting-passkey-approval";
      for: "attach-policy" | "add-signer";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      summary: MintConfirmationSummary;
    }
  | {
      step: "attaching-policy";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      summary: MintConfirmationSummary;
    }
  | {
      step: "adding-signer";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      attachTxHash: string;
      summary: MintConfirmationSummary;
    }
  | {
      step: "confirming";
      config: MintConfig;
      key: AgentKeyMaterial;
      policyContractId: string;
      attachTxHash: string;
      addSignerTxHash: string;
      summary: MintConfirmationSummary;
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
      summary: MintConfirmationSummary;
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
      return event.type === "START"
        ? {
            step: "creating-key",
            config: event.config,
            summary: buildMintConfirmationSummary(event.config),
          }
        : state;
    case "creating-key":
      return event.type === "KEY_CREATED"
        ? {
            step: "policy-creation",
            config: state.config,
            key: event.key,
            detail: "Generating policy…",
            summary: buildMintConfirmationSummary(state.config, {
              agentPublicKey: event.key.publicKey,
            }),
          }
        : state;
    case "policy-creation":
      if (event.type === "POLICY_PROGRESS") return { ...state, detail: event.detail };
      if (event.type === "POLICY_DEPLOYED") {
        return {
          step: "awaiting-passkey-approval",
          for: "attach-policy",
          config: state.config,
          key: state.key,
          policyContractId: event.policyContractId,
          summary: buildMintConfirmationSummary(state.config, {
            agentPublicKey: state.key.publicKey,
            policyContractId: event.policyContractId,
          }),
        };
      }
      return state;
    case "awaiting-passkey-approval":
      if (event.type === "PASSKEY_APPROVED" && event.for === state.for) {
        return state.for === "attach-policy"
          ? {
              step: "attaching-policy",
              config: state.config,
              key: state.key,
              policyContractId: state.policyContractId,
              summary: state.summary,
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
          summary: state.summary,
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
            summary: state.summary,
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
            summary: state.summary,
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
            summary: state.summary,
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
  /** Optional hook invoked with the authoritative confirmation summary before passkey signing. */
  onConfirmationSummary?: (summary: MintConfirmationSummary) => void | Promise<void>;
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
  const frozenConfig: MintConfig = { ...config };
  const describe =
    opts.errorMessage ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  let stage: MintStage = "creating-key";
  try {
    dispatch({ type: "START", config: frozenConfig });
    const key = await effects.generateKey();
    dispatch({ type: "KEY_CREATED", key });

    stage = "policy-creation";
    dispatch({ type: "POLICY_PROGRESS", detail: "Generating token budget policy…" });
    const policy = await effects.generatePolicy(frozenConfig, wallet);
    dispatch({ type: "POLICY_PROGRESS", detail: "Checking the deploy will succeed…" });
    const sim = await effects.simulateDeploy(policy.id, wallet);
    if (!sim.ok) throw new Error(sim.error ?? "Policy deploy simulation failed");
    dispatch({ type: "POLICY_PROGRESS", detail: "Deploying the budget policy to testnet…" });
    const { contractId } = await effects.deployInstance(policy.id, wallet);
    dispatch({ type: "POLICY_DEPLOYED", policyContractId: contractId });

    const summary = buildMintConfirmationSummary(frozenConfig, {
      agentPublicKey: key.publicKey,
      policyContractId: contractId,
    });
    if (opts.onConfirmationSummary) {
      await opts.onConfirmationSummary(summary);
    }

    stage = "attaching-policy";
    dispatch({ type: "PASSKEY_APPROVED", for: "attach-policy" });
    const attach = await effects.attachPolicy(contractId);
    await effects.recordDeployment(policy.id, attach.hash, contractId);
    dispatch({ type: "POLICY_ATTACHED", hash: attach.hash });

    stage = "adding-signer";
    const added = await effects.addAgentKey({
      publicKey: key.publicKey,
      token: summary.tokenContractId,
      policyContractId: contractId,
      expiresAtSeconds: summary.expiresAtSeconds,
    });
    dispatch({ type: "SIGNER_ADDED", hash: added.hash });

    stage = "confirming";
    await effects.confirm([attach.hash, added.hash]);
    dispatch({ type: "CONFIRMED" });
  } catch (err) {
    dispatch({ type: "FAIL", stage, message: describe(err) });
  }
}
