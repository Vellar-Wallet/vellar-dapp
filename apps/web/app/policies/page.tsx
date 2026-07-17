"use client";

import { useEffect, useState } from "react";
import type { PolicyDefinition, WalletSession } from "@vela/types";
import { AppShell } from "@/components/app-shell";
import { getWalletRuntime } from "@/lib/connector-factory";
import { useWalletSession } from "@/lib/wallet-context";
import {
  deployPolicy,
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

export default function Policies() {
  const session = useWalletSession();
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
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 22 }}>
        <header>
          <h1 style={{ fontSize: "clamp(1.8rem,4vw,2.4rem)" }}>Account policies</h1>
          <p
            style={{
              marginTop: 12,
              maxWidth: 560,
              fontSize: 15,
              color: "var(--muted)",
              lineHeight: 1.6,
            }}
          >
            Add programmable guardrails to your smart account — spending limits, multisig, contract
            allowlists. Policies come from audited templates and are enforced on-chain, not by a
            promise.
          </p>
        </header>

        {error && (
          <p role="alert" style={{ fontSize: 14, color: "var(--negative)" }}>
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
    return (
      <p className="animate-pulse" style={{ fontSize: 14, color: "var(--muted2)" }}>
        Loading templates…
      </p>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
        gap: 16,
      }}
    >
      {templates.map((t) => {
        const available = t.enforcement.kind !== "custom-contract-pending";
        return (
          <button
            key={t.type}
            onClick={() => available && onPick(t)}
            disabled={!available}
            className="neo"
            style={{
              padding: 18,
              textAlign: "left",
              cursor: available ? "pointer" : "not-allowed",
              opacity: available ? 1 : 0.55,
            }}
          >
            <span className="eyebrow" style={{ fontSize: 10 }}>
              {t.title}
            </span>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              {t.description}
            </p>
            <p style={{ marginTop: 10, fontSize: 11, color: "var(--muted2)" }}>
              {available ? "Configure →" : "Coming soon"}
            </p>
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
    <section
      className="neo"
      style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <span className="eyebrow">{template.title}</span>
      <p style={{ fontSize: 13, color: "var(--muted2)" }}>
        {enforcementLabel(template.enforcement)}
      </p>

      {template.type === "multisig_threshold" && (
        <>
          <label className="form-field">
            <span className="flabel">Co-owner addresses (G… or C…, comma or space separated)</span>
            <textarea
              rows={3}
              value={coOwners}
              onChange={(e) => setCoOwners(e.target.value)}
              placeholder="GABC… GDEF…"
            />
          </label>
          <label className="form-field">
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
          <label className="form-field amount">
            <span className="flabel">Daily limit (XLM, optional)</span>
            <input
              value={dailyXlm}
              onChange={(e) => setDailyXlm(e.target.value)}
              placeholder="100"
              inputMode="decimal"
            />
          </label>
          <label className="form-field amount">
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
        <label className="form-field">
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
        <p style={{ fontSize: 14, color: "var(--muted)" }}>
          Your account ({owner.slice(0, 6)}…{owner.slice(-6)}) as the sole owner. Generate to review
          the policy record.
        </p>
      )}

      {errors.length > 0 && (
        <ul
          role="alert"
          style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--negative)" }}
        >
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={() => void submit()} disabled={busy} className="btn btn-signal">
          {busy ? "Validating…" : "Validate & generate"}
        </button>
        <button onClick={onBack} disabled={busy} className="btn btn-dark">
          Back
        </button>
      </div>
    </section>
  );
}

type DeployState =
  | { name: "idle" }
  | { name: "simulating" }
  | { name: "deploying"; step: string }
  | { name: "done"; contractId: string; attachTxHash: string }
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
    enforcement.kind === "policy-contract" && enforcement.constructorArgs
      ? enforcement.constructorArgs
      : undefined;
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

  return (
    <section
      className="neo"
      style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <span className="verified" style={{ alignSelf: "flex-start", color: "var(--signal)" }}>
        ✓ Policy generated — review before deploying
      </span>

      <div className="neo-inset" style={{ padding: "14px 16px" }}>
        <span className="lbl mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
          POLICY DEFINITION
        </span>
        <pre
          className="mono"
          style={{
            margin: "8px 0 0",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "var(--ink)",
          }}
        >
          {JSON.stringify(policy.definition, null, 2)}
        </pre>
      </div>

      <div className="neo-inset" style={{ padding: "14px 16px" }}>
        <span className="lbl mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
          CONTENT HASH
        </span>
        <p className="mono" style={{ margin: "6px 0 0", fontSize: 12, wordBreak: "break-all" }}>
          {policy.policyHash}
        </p>
      </div>

      <p style={{ fontSize: 13, color: "var(--muted)" }}>
        Enforcement: {enforcementLabel(enforcement)}
      </p>

      {cap && (
        <div
          className="neo-inset"
          style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}
        >
          Your account will be able to move at most{" "}
          <strong style={{ color: "var(--ink)" }}>{stroopsToXlm(cap.dailyLimitStroops)} XLM</strong>{" "}
          in total every {Math.round(cap.windowSeconds / 3600)} hours through this policy. This is a
          cumulative rolling window, not a per-transaction cap — the safe way to bound spend.
        </div>
      )}

      {state.name === "done" ? (
        <div
          className="neo-inset"
          style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}
        >
          <p style={{ margin: 0, color: "var(--signal)", fontWeight: 700 }}>
            ✓ Policy attached to your account
          </p>
          <p className="mono" style={{ margin: "8px 0 0", fontSize: 11, wordBreak: "break-all" }}>
            contract {state.contractId}
          </p>
          <p className="mono" style={{ margin: "4px 0 0", fontSize: 11, wordBreak: "break-all" }}>
            tx {state.attachTxHash}
          </p>
        </div>
      ) : deployable ? (
        <div
          className="neo-inset"
          style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}
        >
          Deploying attaches this policy to your smart account: we deploy a policy contract bound to
          your account, then you approve the attach in your passkey. Nothing is signed silently.
        </div>
      ) : (
        <div
          className="neo-inset"
          style={{ padding: "14px 16px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}
        >
          This policy type is enforced by the smart wallet&apos;s native signer limits rather than a
          deployed contract; the authored policy and its hash are recorded now. On-chain wiring for
          this template is tracked in BUILD-PLAN.
        </div>
      )}

      {state.name === "error" && (
        <p role="alert" style={{ fontSize: 13, color: "var(--negative)" }}>
          {state.message}
        </p>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {deployable && state.name !== "done" && (
          <button onClick={() => void runDeploy()} disabled={busy} className="btn btn-signal">
            {state.name === "simulating"
              ? "Checking…"
              : state.name === "deploying"
                ? state.step
                : "Deploy to my account"}
          </button>
        )}
        <button onClick={onDone} disabled={busy} className="btn btn-dark">
          {state.name === "done" ? "Done" : "Back"}
        </button>
      </div>
    </section>
  );
}
