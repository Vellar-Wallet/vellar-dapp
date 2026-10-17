"use client";

import { useReducer, useState } from "react";
import type { WalletSession } from "@vellar/types";
import { formatTokenAmount, parseTokenAmount, type TokenInfo } from "vellar-sdk";
import { isUserCancellation } from "@vellar/passkey";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { generateAgentKey, redactSecrets } from "@/lib/agent-key";
import {
  initialMintState,
  isMintBusy,
  mintReducer,
  runMint,
  type MintConfig,
  type MintEffects,
} from "@/lib/agent-mint";
import { useBalances } from "@/lib/balances";
import { getWalletRuntime } from "@/lib/connector-factory";
import { walletErrorMessage } from "@/lib/messages";
import {
  deployPolicyInstance,
  generatePolicy,
  recordDeployment,
  simulatePolicyDeploy,
  validatePolicy,
} from "@/lib/policy";
import { readProvenancePreference } from "@/lib/provenance";
import { signerMutationErrorMessage } from "@/lib/signer-model";
import { useInvalidateSigners, useSigners } from "@/lib/signers";
import { trackTransaction } from "@/lib/track";

// Agent session keys (#394, technical-doc.md §17.3): mint a policy-limited
// ed25519 key with an expiry and a per-token budget. The budget is a
// token-scoped spending-limit policy contract deployed for THIS account and
// bound to THIS token; the agent signer's SignerLimits name that policy as a
// required co-signer, so every spend is checked on-chain in __check_auth.
// Nothing in this component computes or enforces the budget.
//
// TESTNET ONLY: the token-scoped policy is validated on testnet; mainnet use
// is gated on the smart-contract security checklist (idea.md §12). The card
// refuses to mint on any other network.

/** Default warning window (24 hours in ms) before an agent key's expiry. */
export const DEFAULT_EXPIRY_WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type AgentKeyExpiryStatus =
  | { kind: "no-expiry" }
  | { kind: "expired"; remainingMs: 0; label: string }
  | { kind: "nearing-expiry"; remainingMs: number; countdown: string; label: string }
  | { kind: "healthy"; remainingMs: number };

export function formatExpiryCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function computeAgentKeyExpiryStatus(
  expiresAt: string | number | undefined | null,
  nowMs: number = Date.now(),
  thresholdMs: number = DEFAULT_EXPIRY_WARNING_THRESHOLD_MS,
): AgentKeyExpiryStatus {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") {
    return { kind: "no-expiry" };
  }
  const expiresAtMs =
    typeof expiresAt === "number"
      ? expiresAt < 1e12
        ? expiresAt * 1000
        : expiresAt
      : Date.parse(expiresAt);

  if (!Number.isFinite(expiresAtMs)) {
    return { kind: "no-expiry" };
  }

  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return { kind: "expired", remainingMs: 0, label: "Expired" };
  }
  if (remainingMs <= thresholdMs) {
    const countdown = formatExpiryCountdown(remainingMs);
    return {
      kind: "nearing-expiry",
      remainingMs,
      countdown,
      label: `Expires in ${countdown}`,
    };
  }
  return { kind: "healthy", remainingMs };
}

const EXPIRY_OPTIONS: Array<{ label: string; seconds?: number }> = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { label: "No expiry (not recommended)" },
];

const WINDOW_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "per hour", seconds: 60 * 60 },
  { label: "per 24 hours", seconds: 24 * 60 * 60 },
  { label: "per 7 days", seconds: 7 * 24 * 60 * 60 },
];

export function AgentKeysCard({
  session,
  expiryWarningThresholdMs = DEFAULT_EXPIRY_WARNING_THRESHOLD_MS,
  nowMs,
}: {
  session: WalletSession;
  /** Configurable threshold (in ms) before expiry at which a key shows a countdown warning. */
  expiryWarningThresholdMs?: number;
  /** Optional clock override for deterministic testing. */
  nowMs?: number;
}) {
  const balances = useBalances(session.accountId);
  const signers = useSigners(session.accountId, session.network, session.keyId);
  const invalidateSigners = useInvalidateSigners(session.accountId, session.network);
  const [state, dispatch] = useReducer(mintReducer, initialMintState);
  const [tokenId, setTokenId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(1);
  const [windowIdx, setWindowIdx] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens: TokenInfo[] = balances.data ?? [];
  const token = tokens.find((t) => t.contractId === tokenId) ?? tokens[0];
  const testnet = session.network === "testnet";
  const busy = isMintBusy(state);
  const agentSigners = (signers.data ?? []).filter((s) => s.kind === "agent");
  const currentNowMs = nowMs ?? Date.now();

  // #398 composition: when a verified-provenance policy is attached to the
  // account (strict / trusted publishers), every agent key minted from here
  // names it as a SECOND required co-signer next to the budget policy — the
  // wallet then consults both in __check_auth: budget caps how much,
  // provenance caps through-what. Attachment is read from chain, not from the
  // stored preference.
  const provenancePolicy = (() => {
    const pref = readProvenancePreference(session.accountId) as {
      policyContractId?: string;
      mode: string;
    };
    if (!pref.policyContractId || (pref.mode !== "strict" && pref.mode !== "trusted_publishers")) {
      return undefined;
    }
    const attached = (signers.data ?? []).some(
      (s) => s.kind === "policy" && s.key.value === pref.policyContractId,
    );
    return attached ? pref.policyContractId : undefined;
  })();

  function buildConfig(): MintConfig | null {
    if (!token) {
      setFormError("No token available to budget. Fund the wallet first.");
      return null;
    }
    let base: bigint;
    try {
      base = parseTokenAmount(amount.trim(), token.decimals);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Enter a valid budget amount.");
      return null;
    }
    if (base <= 0n) {
      setFormError("The budget must be at least one base unit.");
      return null;
    }
    const expiry = EXPIRY_OPTIONS[expiryIdx]!;
    const win = WINDOW_OPTIONS[windowIdx]!;
    return {
      token: token.contractId,
      tokenSymbol: token.symbol,
      amountBaseUnits: base.toString(),
      windowSeconds: win.seconds,
      expiresAtSeconds: expiry.seconds ? Math.floor(Date.now() / 1000) + expiry.seconds : undefined,
      network: session.network,
    };
  }

  async function mint() {
    setFormError(null);
    setCopied(false);
    if (!testnet) {
      setFormError(
        "Agent keys are testnet-only until the mainnet smart-contract checklist is complete.",
      );
      return;
    }
    const config = buildConfig();
    if (!config) return;

    const effects: MintEffects = {
      generateKey: generateAgentKey,
      async generatePolicy(cfg, wallet) {
        const definition = {
          version: "1",
          type: "token_spending_limit",
          owners: [wallet],
          tokenBudget: {
            token: cfg.token,
            amountBaseUnits: cfg.amountBaseUnits,
            windowSeconds: cfg.windowSeconds,
          },
        };
        const validation = await validatePolicy(definition);
        if (!validation.valid) throw new Error(validation.errors.join("; "));
        return generatePolicy(definition);
      },
      simulateDeploy: simulatePolicyDeploy,
      deployInstance: deployPolicyInstance,
      async attachPolicy(policyContractId) {
        const runtime = await getWalletRuntime();
        if (session.keyId) await runtime.resume(session.keyId);
        return runtime.attachPolicy(policyContractId);
      },
      recordDeployment,
      async addAgentKey(input) {
        const runtime = await getWalletRuntime();
        if (session.keyId) await runtime.resume(session.keyId);
        return runtime.addAgentKey({
          publicKey: input.publicKey,
          grants: [
            {
              token: input.token,
              policies: provenancePolicy
                ? [input.policyContractId, provenancePolicy]
                : [input.policyContractId],
            },
          ],
          expirationSeconds: input.expiresAtSeconds,
          store: "persistent",
        });
      },
      async confirm(hashes) {
        for (const hash of hashes) {
          const result = await trackTransaction(hash);
          if (result !== "success") throw new Error(`Transaction ${hash} failed on the network.`);
        }
      },
    };

    await runMint(config, {
      effects,
      wallet: session.accountId,
      dispatch,
      errorMessage: (err) =>
        isUserCancellation(err)
          ? "The passkey approval was dismissed. The mint was not completed."
          : redactSecrets(signerMutationErrorMessage(err, walletErrorMessage(err))),
    });
    void invalidateSigners();
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="lpa-panel" aria-labelledby="agent-keys-heading">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow id="agent-keys-heading">Agent keys</Eyebrow>
        <span
          className={`px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] ${
            testnet ? "bg-[var(--lp-mint-soft)]" : "lpa-bad bg-[var(--lp-paper)]"
          }`}
          data-testid="agent-network-badge"
        >
          {session.network} {testnet ? "· testnet-only feature" : "· not available"}
        </span>
      </div>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Give an agent its own key with a budget instead of your passkey. Minting deploys a
        token-scoped spending-limit policy contract for this account and adds the agent&apos;s key
        as a signer that can only spend through that policy. You approve both steps with your
        passkey; this is an explicit grant of bounded, pre-authorised delegation.
      </p>

      {agentSigners.length > 0 && (
        <ul
          className="mt-3 m-0 flex list-none flex-col gap-2 p-0"
          data-testid="agent-keys-expiry-list"
        >
          {agentSigners.map((signer) => {
            const expiryStatus =
              signer.status === "expired"
                ? ({ kind: "expired", remainingMs: 0, label: "Expired" } as const)
                : computeAgentKeyExpiryStatus(
                    signer.expiresAt,
                    currentNowMs,
                    expiryWarningThresholdMs,
                  );

            return (
              <li
                key={signer.id}
                data-testid="agent-key-expiry-item"
                className="lpa-well flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <span className="font-[family-name:var(--lp-mono)]">
                  {signer.key.value.slice(0, 6)}…{signer.key.value.slice(-6)}
                </span>
                {expiryStatus.kind === "nearing-expiry" && (
                  <span
                    data-testid="agent-key-expiry-countdown"
                    className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800"
                  >
                    ⚠ {expiryStatus.label}
                  </span>
                )}
                {expiryStatus.kind === "expired" && (
                  <span
                    data-testid="agent-key-expired-badge"
                    className="rounded bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700"
                  >
                    Expired
                  </span>
                )}
                {expiryStatus.kind === "no-expiry" && (
                  <span
                    data-testid="agent-key-no-expiry"
                    className="text-[11px] text-[var(--lp-ink-faint)]"
                  >
                    No expiry set
                  </span>
                )}
                {expiryStatus.kind === "healthy" && signer.expiresAt && (
                  <span
                    data-testid="agent-key-expiry-healthy"
                    className="text-[11px] text-[var(--lp-ink-soft)]"
                  >
                    Active until {new Date(signer.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!testnet && (
        <p role="alert" className="lpa-bad mt-3.5! text-sm">
          Agent keys are testnet-only until the mainnet smart-contract checklist is complete. This
          account is on {session.network}.
        </p>
      )}

      {testnet && state.step !== "success" && (
        <form
          className="mt-3.5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <label className="lpa-field">
            <span className="flabel">Token the budget applies to</span>
            <select
              value={token?.contractId ?? ""}
              onChange={(e) => setTokenId(e.target.value)}
              disabled={busy || tokens.length === 0}
            >
              {tokens.map((t) => (
                <option key={t.contractId} value={t.contractId}>
                  {t.symbol} — {t.contractId.slice(0, 6)}…{t.contractId.slice(-6)}
                </option>
              ))}
            </select>
          </label>
          <label className="lpa-field">
            <span className="flabel">Budget ({token?.symbol ?? "token"}) per window</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10"
              inputMode="decimal"
              disabled={busy}
            />
          </label>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <label className="lpa-field">
              <span className="flabel">Budget window</span>
              <select
                value={windowIdx}
                onChange={(e) => setWindowIdx(Number(e.target.value))}
                disabled={busy}
              >
                {WINDOW_OPTIONS.map((w, i) => (
                  <option key={w.label} value={i}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lpa-field">
              <span className="flabel">Key expiry</span>
              <select
                value={expiryIdx}
                onChange={(e) => setExpiryIdx(Number(e.target.value))}
                disabled={busy}
              >
                {EXPIRY_OPTIONS.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]"
            data-testid="budget-semantics"
          >
            <strong>What the chain will enforce.</strong> The agent can move at most{" "}
            <strong>
              {amount.trim() || "…"} {token?.symbol ?? ""}
            </strong>{" "}
            in total {WINDOW_OPTIONS[windowIdx]!.label}, counted by the policy contract, and only
            for this token — transfers of any other token are rejected. The window is a fixed
            (tumbling) period that resets on a schedule, not a continuously sliding one, so spending
            just before and just after a reset can move up to twice the budget within a short span.
            The key stops working at its expiry, and you can revoke it from the signer list at any
            time (remote kill). The SDK&apos;s client-side <code>maxAmount</code> is a convenience
            guard only; the on-chain policy is the budget.
            {provenancePolicy && (
              <span className="mt-2 block" data-testid="provenance-cosigner">
                <strong>Verified provenance is on for this account:</strong> the agent key will also
                require the attached provenance policy to approve every spend, so it can only
                transact through contracts with verified source provenance (provenance, not safety).
              </span>
            )}
          </div>

          {formError && (
            <p role="alert" className="lpa-bad m-0! text-sm">
              {formError}
            </p>
          )}

          <LpActionButton type="submit" className="self-start" disabled={busy || !token}>
            {stepLabel(state.step, "for" in state ? state.for : undefined)}
          </LpActionButton>

          {"detail" in state && (
            <p className="m-0! animate-pulse text-xs text-[var(--lp-ink-soft)]">{state.detail}</p>
          )}
          {state.step === "confirming" && (
            <p className="m-0! animate-pulse text-xs text-[var(--lp-ink-soft)]">
              Confirming on the network… policy {state.attachTxHash} · signer{" "}
              {state.addSignerTxHash}
            </p>
          )}
          {state.step === "error" && (
            <div className="flex flex-col gap-2">
              <p role="alert" className="lpa-bad m-0! text-sm">
                Mint failed while {STAGE_LABEL[state.stage]}: {state.message}
              </p>
              {state.signerMayExist && (
                <p className="m-0! text-xs text-[var(--lp-ink-soft)]">
                  The agent signer transaction was submitted before this failure, so an agent key
                  may exist on the account. Refresh the signer list and revoke it if you did not
                  receive its secret.
                </p>
              )}
              <LpActionButton
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => dispatch({ type: "RESET" })}
              >
                Start over
              </LpActionButton>
            </div>
          )}
        </form>
      )}

      {state.step === "success" && (
        <div className="mt-3.5 flex flex-col gap-3 text-sm" data-testid="mint-success">
          <span className="lpa-ok font-bold">✓ Agent key minted and bounded on-chain</span>
          <dl className="lpa-well m-0 flex flex-col gap-1.5 text-xs">
            <Row label="Network" value={state.config.network.toUpperCase()} />
            <Row label="Agent public key" value={state.publicKey} />
            <Row label="Budget policy" value={state.policyContractId} />
            <Row
              label="Budget"
              value={`${formatTokenAmount(BigInt(state.config.amountBaseUnits), token?.decimals ?? 7)} ${state.config.tokenSymbol} ${WINDOW_OPTIONS.find((w) => w.seconds === state.config.windowSeconds)?.label ?? ""}`}
            />
            <Row
              label="Expires"
              value={
                state.config.expiresAtSeconds
                  ? new Date(state.config.expiresAtSeconds * 1000).toLocaleString()
                  : "never"
              }
            />
            <Row label="Policy attach tx" value={state.attachTxHash} />
            <Row label="Add signer tx" value={state.addSignerTxHash} />
          </dl>

          {state.secret ? (
            <div
              className="lpa-well flex flex-col gap-2 border-2 border-[var(--lpa-bad)]"
              data-testid="secret-reveal"
            >
              <p className="m-0! font-bold">Agent secret — shown once, never again</p>
              <p className="m-0! text-xs text-[var(--lp-ink-soft)]">
                Copy this into your agent&apos;s configuration now. Vellar does not store it; when
                you dismiss this panel it is gone. Anyone holding it can spend this account&apos;s{" "}
                {state.config.tokenSymbol} up to the on-chain budget until the key expires or you
                revoke it.
              </p>
              <code
                className="break-all font-[family-name:var(--lp-mono)] text-xs"
                data-testid="agent-secret"
              >
                {state.secret}
              </code>
              <div className="flex gap-2.5">
                <LpActionButton size="sm" onClick={() => void copySecret(state.secret!)}>
                  {copied ? "Copied" : "Copy secret"}
                </LpActionButton>
                <LpActionButton
                  variant="outline"
                  size="sm"
                  onClick={() => dispatch({ type: "DISMISS_SECRET" })}
                >
                  I have stored it — dismiss forever
                </LpActionButton>
              </div>
            </div>
          ) : (
            <p className="m-0! text-xs text-[var(--lp-ink-faint)]" data-testid="secret-dismissed">
              The secret was dismissed and cannot be shown again. If it was lost, revoke this key
              from the signer list and mint a new one.
            </p>
          )}

          <LpActionButton
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => dispatch({ type: "RESET" })}
          >
            Mint another
          </LpActionButton>
        </div>
      )}
    </section>
  );
}

const STAGE_LABEL = {
  "creating-key": "generating the agent key",
  "policy-creation": "deploying the budget policy",
  "attaching-policy": "attaching the policy",
  "adding-signer": "adding the agent signer",
  confirming: "confirming on the network",
} as const;

function stepLabel(step: string, prompt?: "attach-policy" | "add-signer"): string {
  switch (step) {
    case "creating-key":
      return "Generating agent key…";
    case "policy-creation":
      return "Deploying budget policy…";
    case "awaiting-passkey-approval":
      return prompt === "add-signer"
        ? "Approve the agent signer with your passkey…"
        : "Approve the policy attach with your passkey…";
    case "attaching-policy":
      return "Approve the policy attach with your passkey…";
    case "adding-signer":
      return "Approve the agent signer with your passkey…";
    case "confirming":
      return "Confirming on the network…";
    default:
      return "Mint agent key — approve with passkey";
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--lp-ink-faint)]">{label}</dt>
      <dd className="m-0 break-all text-right font-[family-name:var(--lp-mono)]">{value}</dd>
    </div>
  );
}
