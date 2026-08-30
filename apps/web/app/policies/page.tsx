"use client";

import { useEffect, useState } from "react";
import type { PolicyDefinition, WalletSession } from "@vellar/types";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { getWalletRuntime } from "@/lib/connector-factory";
import { useWalletSession } from "@/lib/wallet-context";
import { isFlagEnabled, readFlagConfig } from "@/lib/feature-flags";
import {
  deployPolicy,
  detachPolicy,
  enforcementLabel,
  generatePolicy,
  listTemplates,
  simulatePolicyDeploy,
  stroopsToXlm,
  validatePolicy,
  type GeneratedPolicy,
  type PolicyTemplateInfo,
} from "@/lib/policy";

// Policy builder (technical-doc.md §5.4, §7.5; idea.md §6.2, §19 D3 — policies
// come from structured templates, reviewed before deploy). Flow: pick template
// → configure params → validate → review generated artifacts (JSON, hash,
// manifest) → deploy on-chain (deploy the policy contract instance bound to the
// account, then passkey-sign kit.addPolicy to attach it — no silent signing).

type Stage =
  | { name: "pick" }
  | { name: "configure"; template: PolicyTemplateInfo }
  | { name: "review"; template: PolicyTemplateInfo; policy: GeneratedPolicy };

// Feature flag gating the policy builder's gradual rollout (#335 —
// docs/decisions.md records the flag name and rollout plan). Read once at
// module load: the env vars it's built from are inlined at Next.js build
// time (NEXT_PUBLIC_*), so there's no benefit to re-reading them per render,
// and reading it here (not inside the component) keeps
// PolicyBuilderFlagged's gating logic testable without rendering the whole
// page tree.
const POLICY_BUILDER_FLAG = readFlagConfig("policyBuilderV2");

/** Exported for tests — the gating decision as a pure function of session. */
export function policyBuilderVisibleFor(accountId: string | null): boolean {
  return isFlagEnabled(POLICY_BUILDER_FLAG, accountId);
}

export default function Policies() {
  const session = useWalletSession();

  if (!policyBuilderVisibleFor(session?.accountId ?? null)) {
    return <PolicyBuilderNotYetAvailable />;
  }

  return <PolicyBuilder session={session} />;
}

/**
 * Shown to a connected wallet not yet in the policy-builder rollout, and to
 * anyone with no wallet connected yet (accountId unavailable — see
 * isFlagEnabled's doc: there is no stable identity to bucket against yet).
 * A flagged-out user gets an honest "not yet" state rather than either a
 * broken partial UI or a silently missing page.
 */
function PolicyBuilderNotYetAvailable() {
  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <header>
          <h1>Account policies</h1>
          <p className="mt-3! max-w-[560px] text-[15px] leading-relaxed text-[var(--lp-ink-soft)]">
            Programmable account policies — spending limits, multisig, contract allowlists — are
            rolling out gradually. This account isn't in the rollout yet; check back soon.
          </p>
        </header>
      </div>
    </AppShell>
  );
}

function PolicyBuilder({ session }: { session: WalletSession | null }) {
  const [templates, setTemplates] = useState<PolicyTemplateInfo[] | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch(() => setError("Couldn't load policy templates."));
  }, []);

  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <header>
          <h1>Account policies</h1>
          <p className="mt-3! max-w-[560px] text-[15px] leading-relaxed text-[var(--lp-ink-soft)]">
            Add programmable guardrails to your smart account — spending limits, multisig, contract
            allowlists. Policies are built from structured templates and enforced on-chain — by the
            deployed contract, not by the app.
          </p>
        </header>

        {error && (
          <p role="alert" className="lpa-bad text-sm">
            {error}
          </p>
        )}

        {stage.name === "pick" && (
          <TemplatePicker
            templates={templates}
            onPick={(template) => setStage({ name: "configure", template })}
          />
        )}

        {stage.name === "configure" && session && (
          <ConfigureForm
            template={stage.template}
            owner={session.accountId}
            onBack={() => setStage({ name: "pick" })}
            onGenerated={(policy) => setStage({ name: "review", template: stage.template, policy })}
          />
        )}

        {stage.name === "review" && session && (
          <ReviewCard
            policy={stage.policy}
            session={session}
            onDone={() => setStage({ name: "pick" })}
          />
        )}
      </div>
    </AppShell>
  );
}

function TemplatePicker({
  templates,
  onPick,
}: {
  templates: PolicyTemplateInfo[] | null;
  onPick: (t: PolicyTemplateInfo) => void;
}) {
  if (!templates) {
    return <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading templates…</p>;
  }
  // Available templates first, unavailable ("Coming soon") last — a stable sort
  // keeps the registry's order within each group so live templates don't get an
  // unavailable one wedged between them.
  const isAvailable = (t: PolicyTemplateInfo) => t.enforcement.kind !== "custom-contract-pending";
  const ordered = [...templates].sort((a, b) => Number(isAvailable(b)) - Number(isAvailable(a)));
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
      {ordered.map((t) => {
        const available = isAvailable(t);
        return (
          <button
            key={t.type}
            onClick={() => available && onPick(t)}
            disabled={!available}
            className="lpa-panel"
          >
            <span className="block font-[family-name:var(--lp-display)] text-[15px] font-bold">
              {t.title}
            </span>
            <span className="mt-2 block text-[13px] leading-normal text-[var(--lp-ink-soft)]">
              {t.description}
            </span>
            <span className="mt-2.5 block text-[11px] font-bold text-[var(--lp-ink-faint)]">
              {available ? "Configure →" : "Coming soon"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ConfigureForm({
  template,
  owner,
  onBack,
  onGenerated,
}: {
  template: PolicyTemplateInfo;
  owner: string;
  onBack: () => void;
  onGenerated: (p: GeneratedPolicy) => void;
}) {
  // Per-template controlled fields; the definition is assembled on submit.
  const [threshold, setThreshold] = useState("2");
  const [coOwners, setCoOwners] = useState("");
  const [dailyXlm, setDailyXlm] = useState("");
  const [perTxXlm, setPerTxXlm] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  function buildDefinition(): PolicyDefinition {
    const owners = [owner, ...coOwners.split(/[\s,]+/).filter(Boolean)];
    switch (template.type) {
      case "single_owner":
        return { version: "1", type: "single_owner", owners: [owner] };
      case "multisig_threshold":
        return {
          version: "1",
          type: "multisig_threshold",
          owners,
          threshold: Number(threshold),
        };
      case "spending_limit":
        return {
          version: "1",
          type: "spending_limit",
          owners: [owner],
          spendingLimits: {
            ...(dailyXlm ? { dailyXlm } : {}),
            ...(perTxXlm ? { perTxXlm } : {}),
          },
        };
      case "contract_allowlist":
        return {
          version: "1",
          type: "contract_allowlist",
          owners: [owner],
          allowlistedContracts: allowlist.split(/[\s,]+/).filter(Boolean),
        };
      default:
        return { version: "1", type: template.type, owners: [owner] };
    }
  }

  async function submit() {
    setBusy(true);
    setErrors([]);
    try {
      const definition = buildDefinition();
      const validation = await validatePolicy(definition);
      if (!validation.valid) {
        setErrors(validation.errors);
        return;
      }
      onGenerated(await generatePolicy(definition));
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Something went wrong"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lpa-panel flex flex-col gap-3.5">
      <Eyebrow>{template.title}</Eyebrow>
      <p className="text-[13px] text-[var(--lp-ink-faint)]">
        {enforcementLabel(template.enforcement)}
      </p>

      {template.type === "multisig_threshold" && (
        <>
          <label className="lpa-field">
            <span className="flabel">Co-owner addresses (G… or C…, comma or space separated)</span>
            <textarea
              rows={3}
              value={coOwners}
              onChange={(e) => setCoOwners(e.target.value)}
              placeholder="GABC… GDEF…"
            />
          </label>
          <label className="lpa-field">
            <span className="flabel">Approvals required (threshold)</span>
            <input
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              inputMode="numeric"
            />
          </label>
        </>
      )}

      {template.type === "spending_limit" && (
        <>
          <label className="lpa-field">
            <span className="flabel">Daily limit (XLM, optional)</span>
            <input
              value={dailyXlm}
              onChange={(e) => setDailyXlm(e.target.value)}
              placeholder="100"
              inputMode="decimal"
            />
          </label>
          <label className="lpa-field">
            <span className="flabel">Per-transaction limit (XLM, optional)</span>
            <input
              value={perTxXlm}
              onChange={(e) => setPerTxXlm(e.target.value)}
              placeholder="25"
              inputMode="decimal"
            />
          </label>
        </>
      )}

      {template.type === "contract_allowlist" && (
        <label className="lpa-field">
          <span className="flabel">Allowed contracts (C… addresses)</span>
          <textarea
            rows={3}
            value={allowlist}
            onChange={(e) => setAllowlist(e.target.value)}
            placeholder="CABC… CDEF…"
          />
        </label>
      )}

      {template.type === "single_owner" && (
        <p className="text-sm text-[var(--lp-ink-soft)]">
          Your account ({owner.slice(0, 6)}…{owner.slice(-6)}) as the sole owner. Generate to review
          the policy record.
        </p>
      )}

      {errors.length > 0 && (
        <ul role="alert" className="lpa-bad m-0 pl-4.5 text-[13px]">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-3">
        <LpActionButton onClick={() => void submit()} disabled={busy}>
          {busy ? "Validating…" : "Validate & generate"}
        </LpActionButton>
        <LpActionButton variant="outline" onClick={onBack} disabled={busy}>
          Back
        </LpActionButton>
      </div>
    </section>
  );
}

type DeployState =
  | { name: "idle" }
  | { name: "simulating" }
  | { name: "deploying"; step: string }
  | { name: "done"; contractId: string; attachTxHash: string }
  | { name: "detaching"; contractId: string }
  | { name: "detached"; removalTxHash: string }
  | { name: "error"; message: string };

function ReviewCard({
  policy,
  session,
  onDone,
}: {
  policy: GeneratedPolicy;
  session: WalletSession;
  onDone: () => void;
}) {
  const [state, setState] = useState<DeployState>({ name: "idle" });

  const enforcement = policy.manifest.enforcement;
  // Spending limits deploy a contract instance; other templates don't yet.
  const deployable = enforcement.kind === "policy-contract" && !!enforcement.constructorArgs;
  const cap =
    enforcement.kind === "policy-contract" &&
    enforcement.constructorArgs &&
    "dailyLimitStroops" in enforcement.constructorArgs
      ? enforcement.constructorArgs
      : undefined;
  const isVerifiedOnly = policy.definition.type === "verified_only";
  const busy = state.name === "simulating" || state.name === "deploying";

  async function runDeploy() {
    setState({ name: "simulating" });
    try {
      // 1. Dry-run so a bad deploy never reaches the passkey prompt.
      const sim = await simulatePolicyDeploy(policy.id, session.accountId);
      if (!sim.ok) {
        setState({ name: "error", message: sim.error ?? "Simulation failed" });
        return;
      }
      // 2. Deploy the instance + passkey-sign the attach + record.
      setState({ name: "deploying", step: "Deploying policy contract…" });
      const runtime = await getWalletRuntime();
      const result = await deployPolicy(policy.id, session, {
        resume: runtime.resume,
        attachPolicy: async (contractId) => {
          setState({ name: "deploying", step: "Approve in your passkey to attach…" });
          return runtime.attachPolicy(contractId);
        },
      });
      setState({
        name: "done",
        contractId: result.contractId,
        attachTxHash: result.attachTxHash,
      });
    } catch (err) {
      setState({ name: "error", message: err instanceof Error ? err.message : "Deploy failed" });
    }
  }

  async function runDetach(contractId: string) {
    setState({ name: "detaching", contractId });
    try {
      const runtime = await getWalletRuntime();
      const { hash } = await detachPolicy(contractId, session, {
        resume: runtime.resume,
        detachPolicy: runtime.detachPolicy,
      });
      setState({ name: "detached", removalTxHash: hash });
    } catch (err) {
      setState({ name: "error", message: err instanceof Error ? err.message : "Detach failed" });
    }
  }

  return (
    <section className="lpa-panel flex flex-col gap-3.5">
      <span className="lpa-ok self-start text-sm font-bold">
        ✓ Policy generated — review before deploying
      </span>

      <div className="lpa-well">
        <span className="flabel block font-[family-name:var(--lp-mono)] text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
          POLICY DEFINITION
        </span>
        <pre className="mt-2 whitespace-pre-wrap break-all font-[family-name:var(--lp-mono)] text-xs">
          {JSON.stringify(policy.definition, null, 2)}
        </pre>
      </div>

      <div className="lpa-well">
        <span className="flabel block font-[family-name:var(--lp-mono)] text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
          CONTENT HASH
        </span>
        <p className="mt-1.5! break-all font-[family-name:var(--lp-mono)] text-xs">
          {policy.policyHash}
        </p>
      </div>

      <p className="text-[13px] text-[var(--lp-ink-soft)]">
        Enforcement: {enforcementLabel(enforcement)}
      </p>

      {cap && (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          Your account can move up to <strong>{stroopsToXlm(cap.dailyLimitStroops)} XLM</strong>{" "}
          total per {Math.round(cap.windowSeconds / 3600)}-hour period through this policy. The
          limit resets on a fixed schedule, not a continuously sliding window — so transfers made
          just before and just after a reset can move up to twice that amount within a short span.
          Use it as a spending guardrail, and pair it with a co-signer if you need a hard cap.
        </div>
      )}

      {isVerifiedOnly && (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          Enforced on-chain against the attestation registry. Verified means provenance, not audited
          or safe.
        </div>
      )}

      {state.name === "done" || state.name === "detaching" ? (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          <p className="lpa-ok m-0! font-bold">✓ Policy attached to your account</p>
          <p className="mt-2! break-all font-[family-name:var(--lp-mono)] text-[11px]">
            contract {state.contractId}
          </p>
          {state.name === "done" && (
            <p className="mt-1! break-all font-[family-name:var(--lp-mono)] text-[11px]">
              tx {state.attachTxHash}
            </p>
          )}
          <p className="mt-3!">
            Changed your mind, or a policy is blocking transactions you need? You can remove it —
            your passkey detaches it directly, no policy approval required.
          </p>
          <LpActionButton
            variant="outline"
            size="sm"
            className="mt-2.5"
            disabled={state.name === "detaching"}
            onClick={() => void runDetach(state.contractId)}
          >
            {state.name === "detaching"
              ? "Approve in your passkey to remove…"
              : "Detach this policy"}
          </LpActionButton>
        </div>
      ) : state.name === "detached" ? (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          <p className="lpa-ok m-0! font-bold">✓ Policy removed</p>
          <p className="mt-2! break-all font-[family-name:var(--lp-mono)] text-[11px]">
            tx {state.removalTxHash}
          </p>
        </div>
      ) : deployable ? (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          Deploying attaches this policy to your smart account: we deploy a policy contract bound to
          your account, then you approve the attach in your passkey. Nothing is signed silently.
        </div>
      ) : (
        <div className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
          This policy type is enforced by the smart wallet&apos;s native signer limits rather than a
          deployed contract; the authored policy and its hash are recorded now. On-chain wiring for
          this template is tracked in BUILD-PLAN.
        </div>
      )}

      {state.name === "error" && (
        <p role="alert" className="lpa-bad text-[13px]">
          {state.message}
        </p>
      )}

      <div className="flex items-center gap-3">
        {deployable && state.name !== "done" && (
          <LpActionButton onClick={() => void runDeploy()} disabled={busy}>
            {state.name === "simulating"
              ? "Checking…"
              : state.name === "deploying"
                ? state.step
                : "Deploy to my account"}
          </LpActionButton>
        )}
        <LpActionButton variant="outline" onClick={onDone} disabled={busy}>
          {state.name === "done" ? "Done" : "Back"}
        </LpActionButton>
      </div>
    </section>
  );
}
