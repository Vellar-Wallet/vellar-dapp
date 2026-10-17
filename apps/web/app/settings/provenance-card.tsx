"use client";

import { useEffect, useState } from "react";
import type { WalletSession } from "@vellar/types";
import { isUserCancellation } from "@vellar/passkey";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { getWalletRuntime } from "@/lib/connector-factory";
import { walletErrorMessage } from "@/lib/messages";
import {
  deployPolicyInstance,
  generatePolicy,
  recordDeployment,
  simulatePolicyDeploy,
  validatePolicy,
} from "@/lib/policy";
import {
  provenancePolicyDefinition,
  readProvenancePreference,
  writeProvenancePreference,
  type ProvenanceMode,
} from "@/lib/provenance";
import { isPolicySigner, useInvalidateSigners, useSigners } from "@/lib/signers";
import { trackTransaction } from "@/lib/track";

// Verified-only signing (#398). Modes:
//   off                 — no provenance check.
//   warn                — wallet-side: the send flow shows a provenance warning
//                         for targets without verified source and lets you
//                         proceed. A signal, not a control.
//   strict              — on-chain: a verified-provenance policy is attached
//                         to the account; the account contract rejects any
//                         authorization that invokes a contract without a live
//                         attestation. Enforced in __check_auth, not here.
//   trusted_publishers  — on-chain: same policy, restricted to attestations
//                         attributed to publishers you list.
// Strict / trusted publishers are represented by the policy signer on the
// account (it appears in the signer list; "Detach policy" there is the
// recovery path, and works even when the attestation registry is unavailable
// because the account removes a policy without consulting it).

type DeployState =
  | { step: "idle" }
  | { step: "generating"; detail: string }
  | { step: "approving"; contractId: string }
  | { step: "confirming"; contractId: string; hash: string }
  | { step: "done"; contractId: string; hash: string }
  | { step: "error"; message: string };

interface Pref {
  mode: ProvenanceMode;
  trustedPublishers?: string[];
  /** The attached verified-provenance policy instance, when strict/trusted. */
  policyContractId?: string;
}

export function ProvenanceCard({ session }: { session: WalletSession }) {
  const signers = useSigners(session.accountId, session.network, session.keyId);
  const invalidateSigners = useInvalidateSigners(session.accountId, session.network);
  const [pref, setPref] = useState<Pref>({ mode: "off" });
  const [mode, setMode] = useState<ProvenanceMode>("off");
  const [publishers, setPublishers] = useState("");
  const [state, setState] = useState<DeployState>({ step: "idle" });

  useEffect(() => {
    const stored = readProvenancePreference(session.accountId) as Pref;
    setPref(stored);
    setMode(stored.mode);
    setPublishers((stored.trustedPublishers ?? []).join("\n"));
  }, [session.accountId]);

  // Chain truth: a strict/trusted preference only holds while its policy
  // signer is actually on the account. If it was detached (here or from
  // another device) the on-chain enforcement is gone and we say so.
  const attachedOnChain =
    !!pref.policyContractId &&
    (signers.data ?? []).some((s) => isPolicySigner(s, pref.policyContractId));
  const onChainMode = pref.mode === "strict" || pref.mode === "trusted_publishers";
  const enforcementLost = onChainMode && signers.data !== undefined && !attachedOnChain;

  function savePref(next: Pref) {
    writeProvenancePreference(session.accountId, next);
    setPref(next);
  }

  function applyClientMode(next: "off" | "warn") {
    savePref({ mode: next });
    setState({ step: "idle" });
  }

  async function deployOnChainMode(next: "strict" | "trusted_publishers") {
    const list = publishers
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (next === "trusted_publishers" && list.length === 0) {
      setState({
        step: "error",
        message: "List at least one trusted publisher (e.g. github.com/vellar-wallet).",
      });
      return;
    }
    setState({ step: "generating", detail: "Generating the provenance policy…" });
    try {
      const definition = provenancePolicyDefinition(session.accountId, next, list);
      const validation = await validatePolicy(definition);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      const policy = await generatePolicy(definition);
      setState({ step: "generating", detail: "Checking the deploy will succeed…" });
      const sim = await simulatePolicyDeploy(policy.id, session.accountId);
      if (!sim.ok) throw new Error(sim.error ?? "Policy deploy simulation failed");
      setState({ step: "generating", detail: "Deploying the policy contract…" });
      const { contractId } = await deployPolicyInstance(policy.id, session.accountId);
      setState({ step: "approving", contractId });
      const runtime = await getWalletRuntime();
      if (session.keyId) await runtime.resume(session.keyId);
      const { hash } = await runtime.attachPolicy(contractId);
      await recordDeployment(policy.id, hash, contractId);
      setState({ step: "confirming", contractId, hash });
      const result = await trackTransaction(hash);
      if (result !== "success") throw new Error(`Transaction ${hash} failed on the network.`);
      savePref({ mode: next, trustedPublishers: list, policyContractId: contractId });
      setState({ step: "done", contractId, hash });
      void invalidateSigners();
    } catch (err) {
      setState({
        step: "error",
        message: isUserCancellation(err)
          ? "The passkey approval was dismissed. No policy was attached."
          : walletErrorMessage(err),
      });
    }
  }

  const busy =
    state.step === "generating" || state.step === "approving" || state.step === "confirming";
  const onChainSelected = mode === "strict" || mode === "trusted_publishers";

  return (
    <section className="lpa-panel" aria-labelledby="provenance-heading">
      <Eyebrow id="provenance-heading">Verified provenance signing</Eyebrow>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Gate what this account signs on whether the target contract has{" "}
        <em>verified source provenance</em> — its deployed code was reproduced from inspectable
        source. Verified means reproducible and attributable; it does not mean audited, benign, free
        of vulnerabilities or upgrade-safe. Strict and trusted-publisher modes are enforced by the
        account contract itself; warn mode is a signal shown before you sign.
      </p>

      <div className="mt-3.5 flex flex-col gap-2" role="radiogroup" aria-label="Provenance mode">
        {(
          [
            ["off", "Off", "No provenance check."],
            [
              "warn",
              "Warn",
              "Before signing, show a provenance warning for targets without verified source. You can still proceed. Enforced by this app, not on-chain.",
            ],
            [
              "strict",
              "Strict (on-chain)",
              "Attach a policy so the account rejects any transaction that runs through a contract without a live attestation in the registry. Enforced in the account contract.",
            ],
            [
              "trusted_publishers",
              "Trusted publishers only (on-chain)",
              "Like strict, but only attestations attributed to publishers you list pass — a publisher set, not a hash list.",
            ],
          ] as const
        ).map(([value, label, blurb]) => (
          <label key={value} className="lpa-well flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="radio"
              name="provenance-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              disabled={busy}
              className="mt-1"
            />
            <span>
              <strong>{label}</strong>
              {pref.mode === value && (
                <span className="ml-2 bg-[var(--lp-mint-soft)] px-2 py-0.5 text-[11px] font-bold">
                  Current
                </span>
              )}
              <span className="block text-xs text-[var(--lp-ink-faint)]">{blurb}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "trusted_publishers" && (
        <label className="lpa-field mt-3">
          <span className="flabel">
            Trusted publishers (one per line, e.g. github.com/vellar-wallet)
          </span>
          <textarea
            rows={3}
            value={publishers}
            onChange={(e) => setPublishers(e.target.value)}
            placeholder="github.com/vellar-wallet"
            disabled={busy}
          />
        </label>
      )}

      {onChainMode && pref.policyContractId && (
        <p
          className="mt-3! break-all text-xs text-[var(--lp-ink-faint)]"
          data-testid="provenance-policy"
        >
          Attached policy:{" "}
          <span className="font-[family-name:var(--lp-mono)]">{pref.policyContractId}</span>
          {attachedOnChain ? " · confirmed on-chain" : ""}
        </p>
      )}

      {enforcementLost && (
        <p role="alert" className="lpa-bad mt-2! text-sm" data-testid="provenance-lost">
          The provenance policy is no longer attached to this account (detached here or from another
          device), so nothing is enforced on-chain right now. Choose a mode again to re-attach, or
          set Off/Warn.
        </p>
      )}

      <div className="mt-3.5 flex flex-col gap-2.5">
        <p className="m-0! text-xs text-[var(--lp-ink-faint)]">
          Network: <strong className="uppercase">{session.network}</strong>.
          {onChainSelected &&
            " Applying deploys a policy contract for this account and asks your passkey to attach it."}
          {onChainMode && mode !== pref.mode && !onChainSelected && attachedOnChain && (
            <> To turn on-chain enforcement off, detach the policy from the signer list above.</>
          )}
        </p>
        <LpActionButton
          className="self-start"
          disabled={busy || mode === pref.mode}
          onClick={() =>
            onChainSelected
              ? void deployOnChainMode(mode as "strict" | "trusted_publishers")
              : applyClientMode(mode as "off" | "warn")
          }
        >
          {state.step === "generating"
            ? state.detail
            : state.step === "approving"
              ? "Approve the policy attach with your passkey…"
              : state.step === "confirming"
                ? "Confirming on the network…"
                : onChainSelected
                  ? "Deploy & attach policy — approve with passkey"
                  : "Apply"}
        </LpActionButton>
      </div>

      {state.step === "done" && (
        <p className="lpa-ok mt-2.5! break-all text-xs">
          ✓ Policy {state.contractId} attached · tx {state.hash}
        </p>
      )}
      {state.step === "error" && (
        <p role="alert" className="lpa-bad mt-2.5! text-sm">
          {state.message}
        </p>
      )}

      <p className="mt-3! text-xs text-[var(--lp-ink-faint)]">
        Recovery: if the attestation registry is unavailable or a contract you need loses its
        attestation, on-chain modes fail closed — the transaction is rejected. Your passkey can
        always detach the policy from the signer list; the account removes a policy signer without
        the policy&apos;s consent.
      </p>
    </section>
  );
}
