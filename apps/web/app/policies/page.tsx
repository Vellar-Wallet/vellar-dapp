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

export interface AttachedPolicyRecord {
  id?: string;
  contractId?: string;
  definition: PolicyDefinition;
}

export interface PolicyConflictWarning {
  attachedContractId?: string;
  attachedType: string;
  candidateType: string;
  overlappingScopes: string[];
  message: string;
}

const attachedPoliciesKey = (accountId: string) => `vellar.attachedPolicies.${accountId}`;

export function readAttachedPolicies(accountId: string | null | undefined): AttachedPolicyRecord[] {
  if (!accountId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(attachedPoliciesKey(accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AttachedPolicyRecord =>
      Boolean(
        item &&
        typeof item === "object" &&
        item.definition &&
        typeof item.definition.type === "string",
      ),
    );
  } catch {
    return [];
  }
}

export function rememberAttachedPolicy(accountId: string, record: AttachedPolicyRecord): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readAttachedPolicies(accountId).filter(
      (item) => !record.contractId || item.contractId !== record.contractId,
    );
    existing.push(record);
    window.localStorage.setItem(attachedPoliciesKey(accountId), JSON.stringify(existing));
  } catch {
    // Display/warning state only; never block deployment if localStorage is unavailable.
  }
}

export function forgetAttachedPolicy(accountId: string, contractId: string): void {
  if (typeof window === "undefined") return;
  try {
    const remaining = readAttachedPolicies(accountId).filter(
      (item) => item.contractId !== contractId,
    );
    window.localStorage.setItem(attachedPoliciesKey(accountId), JSON.stringify(remaining));
  } catch {
    // Ignore storage errors.
  }
}

function extractPolicyDefinition(
  input: PolicyDefinition | GeneratedPolicy | AttachedPolicyRecord,
): { definition: PolicyDefinition; contractId?: string } {
  if ("manifest" in input && "definition" in input) {
    return { definition: input.definition };
  }
  if ("definition" in input) {
    return { definition: input.definition, contractId: input.contractId };
  }
  return { definition: input };
}

function extractPolicyScopes(def: PolicyDefinition): Set<string> {
  const scopes = new Set<string>();
  switch (def.type) {
    case "spending_limit": {
      const hasXlmLimit = Boolean(def.spendingLimits?.dailyXlm || def.spendingLimits?.perTxXlm);
      const maxSingle = def.safetyRules?.maxSingleTransfer ?? [];
      const allowedTokens = def.safetyRules?.allowedTokens ?? [];
      if (hasXlmLimit) {
        scopes.add("spending:XLM");
      }
      for (const rule of maxSingle) {
        if (rule.token) scopes.add(`spending:token:${rule.token}`);
      }
      for (const token of allowedTokens) {
        if (token) scopes.add(`spending:token:${token}`);
      }
      if (allowedTokens.length > 0) {
        scopes.add("spending:token-allowlist");
      }
      if (!hasXlmLimit && maxSingle.length === 0 && allowedTokens.length === 0) {
        scopes.add("spending:XLM");
      }
      break;
    }
    case "token_spending_limit": {
      const token = def.tokenBudget?.token;
      scopes.add(token ? `spending:token:${token}` : "spending:token:*");
      break;
    }
    case "verified_only":
      scopes.add("provenance:contracts");
      break;
    case "contract_allowlist":
      scopes.add("access:contract-allowlist");
      for (const c of def.allowlistedContracts ?? []) {
        if (c) scopes.add(`access:contract:${c}`);
      }
      break;
    case "multisig_threshold":
    case "single_owner":
      scopes.add("auth:owners");
      break;
    default:
      scopes.add(`type:${def.type}`);
      break;
  }
  return scopes;
}

function formatScopeLabel(scope: string): string {
  if (scope === "spending:XLM") return "XLM spending limit";
  if (scope === "spending:token-allowlist") return "allowed token transfer list";
  if (scope.startsWith("spending:token:")) {
    const token = scope.slice("spending:token:".length);
    return `token ${token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-6)}` : token} spending limit`;
  }
  if (scope === "provenance:contracts") return "contract source provenance";
  if (scope === "access:contract-allowlist" || scope.startsWith("access:contract:")) {
    return "contract allowlist";
  }
  if (scope === "auth:owners") return "account owner threshold";
  return scope;
}

/**
 * Detect when a candidate policy being deployed overlaps in scope with one or
 * more already-attached policies on the account. Two policies that govern
 * orthogonal scopes (e.g. an XLM `spending_limit` and a `verified_only`
 * provenance policy, or token budgets for two distinct tokens) produce no
 * conflict warnings.
 */
export function detectPolicyConflicts(
  candidate: PolicyDefinition | GeneratedPolicy,
  attached: ReadonlyArray<PolicyDefinition | GeneratedPolicy | AttachedPolicyRecord>,
): PolicyConflictWarning[] {
  const { definition: candidateDef } = extractPolicyDefinition(candidate);
  const candidateScopes = extractPolicyScopes(candidateDef);
  const warnings: PolicyConflictWarning[] = [];

  for (const item of attached) {
    const { definition: attachedDef, contractId } = extractPolicyDefinition(item);
    const attachedScopes = extractPolicyScopes(attachedDef);
    const shared = [...candidateScopes].filter((s) => attachedScopes.has(s));

    // Also detect when an attached policy restricts `allowedTokens` and the
    // candidate budgets a token outside that allowlist (or vice versa).
    const candidateAllowed = candidateDef.safetyRules?.allowedTokens;
    const attachedAllowed = attachedDef.safetyRules?.allowedTokens;
    const candidateTokens = [...candidateScopes]
      .filter((s) => s.startsWith("spending:token:"))
      .map((s) => s.slice("spending:token:".length));
    const attachedTokens = [...attachedScopes]
      .filter((s) => s.startsWith("spending:token:"))
      .map((s) => s.slice("spending:token:".length));

    if (
      attachedAllowed &&
      attachedAllowed.length > 0 &&
      candidateTokens.some((t) => !attachedAllowed.includes(t)) &&
      !shared.includes("spending:token-allowlist")
    ) {
      shared.push("spending:token-allowlist");
    }
    if (
      candidateAllowed &&
      candidateAllowed.length > 0 &&
      attachedTokens.some((t) => !candidateAllowed.includes(t)) &&
      !shared.includes("spending:token-allowlist")
    ) {
      shared.push("spending:token-allowlist");
    }

    if (shared.length > 0) {
      const labels = [...new Set(shared.map(formatScopeLabel))];
      const where = contractId ? ` (${contractId})` : "";
      warnings.push({
        attachedContractId: contractId,
        attachedType: attachedDef.type,
        candidateType: candidateDef.type,
        overlappingScopes: shared,
        message:
          `This ${candidateDef.type} policy overlaps in scope (${labels.join(", ")}) with an ` +
          `already-attached ${attachedDef.type} policy${where}. On-chain, every attached policy ` +
          `must approve a transaction, so the most restrictive rule wins. You can still proceed ` +
          `if this overlap is intentional.`,
      });
    }
  }

  return warnings;
}

/** Decimal token amount (7 decimals, the SAC precision) → integer base units. */
export function xlmToBaseUnits(value: string): string {
  const [whole = "0", frac = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d{0,7}$/.test(frac)) return value;
  return (BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7))).toString();
}

// Feature flag gating the policy builder's gradual rollout (#335 —
// docs/decisions.md records the flag name and rollout plan). Read once at
// module load: the env vars it's built from are inlined at Next.js build
// time (NEXT_PUBLIC_*), so there's no benefit to re-reading them per render,
// and reading it here (not inside the component) keeps
// PolicyBuilderFlagged's gating logic testable without rendering the whole
// page tree.
//
// The env vars MUST be referenced literally here: Next.js only inlines
// `process.env.NEXT_PUBLIC_X` written out in full, so readFlagConfig's own
// computed `process.env[...]` lookup is always undefined in the browser — the
// flag silently stayed at 0% for every account however it was configured.
const POLICY_BUILDER_FLAG = readFlagConfig("policyBuilderV2", {
  NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT:
    process.env.NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT,
  NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST:
    process.env.NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST,
});

/** Exported for tests — the gating decision as a pure function of session. */
export function policyBuilderVisibleFor(accountId: string | null): boolean {
  return isFlagEnabled(POLICY_BUILDER_FLAG, accountId);
}

export default function Policies({
  attachedPolicies: initialAttachedPolicies,
}: {
  attachedPolicies?: AttachedPolicyRecord[];
} = {}) {
  const session = useWalletSession();

  if (!policyBuilderVisibleFor(session?.accountId ?? null)) {
    return <PolicyBuilderNotYetAvailable />;
  }

  return <PolicyBuilder session={session} initialAttachedPolicies={initialAttachedPolicies} />;
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

function PolicyBuilder({
  session,
  initialAttachedPolicies,
}: {
  session: WalletSession | null;
  initialAttachedPolicies?: AttachedPolicyRecord[];
}) {
  const [templates, setTemplates] = useState<PolicyTemplateInfo[] | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [attachedPolicies, setAttachedPolicies] = useState<AttachedPolicyRecord[]>(
    () => initialAttachedPolicies ?? readAttachedPolicies(session?.accountId),
  );

  useEffect(() => {
    if (initialAttachedPolicies !== undefined) {
      setAttachedPolicies(initialAttachedPolicies);
      return;
    }
    setAttachedPolicies(readAttachedPolicies(session?.accountId));
  }, [session?.accountId, initialAttachedPolicies]);

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
            attachedPolicies={attachedPolicies}
            onPolicyAttached={(record) => {
              rememberAttachedPolicy(session.accountId, record);
              setAttachedPolicies((prev) => [
                ...prev.filter((p) => !record.contractId || p.contractId !== record.contractId),
                record,
              ]);
            }}
            onPolicyDetached={(contractId) => {
              forgetAttachedPolicy(session.accountId, contractId);
              setAttachedPolicies((prev) => prev.filter((p) => p.contractId !== contractId));
            }}
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
  // #399 safety rules (spending_limit): token-denominated, never fiat.
  const [capToken, setCapToken] = useState("");
  const [capXlm, setCapXlm] = useState("");
  const [allowedTokens, setAllowedTokens] = useState("");
  // #398 provenance mode (verified_only).
  const [provenanceMode, setProvenanceMode] = useState<"strict" | "trusted_publishers">("strict");
  const [trustedPublishers, setTrustedPublishers] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const splitList = (raw: string) => raw.split(/[\s,]+/).filter(Boolean);

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
      case "spending_limit": {
        const allowed = splitList(allowedTokens);
        const cap = capToken.trim() && capXlm.trim();
        const safetyRules = {
          ...(cap
            ? {
                maxSingleTransfer: [
                  { token: capToken.trim(), amountBaseUnits: xlmToBaseUnits(capXlm.trim()) },
                ],
              }
            : {}),
          ...(allowed.length > 0 ? { allowedTokens: allowed } : {}),
        };
        return {
          version: "1",
          type: "spending_limit",
          owners: [owner],
          spendingLimits: {
            ...(dailyXlm ? { dailyXlm } : {}),
            ...(perTxXlm ? { perTxXlm } : {}),
          },
          ...(Object.keys(safetyRules).length > 0 ? { safetyRules } : {}),
        };
      }
      case "verified_only":
        return {
          version: "1",
          type: "verified_only",
          owners: [owner],
          provenance:
            provenanceMode === "strict"
              ? { mode: "strict" }
              : { mode: "trusted_publishers", trustedPublishers: splitList(trustedPublishers) },
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

          <div className="lpa-well flex flex-col gap-3" data-testid="safety-rules">
            <p className="m-0! text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
              <strong>On-chain spending controls for supported transfer patterns.</strong> These
              rules are checked by the policy contract itself when the account authorizes a
              transaction — a violating transfer is rejected on-chain, not just warned about. They
              understand one pattern: a token <code>transfer</code> from this account. They are
              denominated in token units (there is no price oracle on Soroban, so never in USD), and
              they are not a universal firewall: value moved through other contract paths is outside
              their view.
            </p>
            <label className="lpa-field">
              <span className="flabel">Max single transfer — token contract (C…, optional)</span>
              <input
                value={capToken}
                onChange={(e) => setCapToken(e.target.value)}
                placeholder="CB… (the XLM asset contract for XLM)"
              />
            </label>
            <label className="lpa-field">
              <span className="flabel">
                Max single transfer — amount (in that token&apos;s units, 7 decimals)
              </span>
              <input
                value={capXlm}
                onChange={(e) => setCapXlm(e.target.value)}
                placeholder="100"
                inputMode="decimal"
              />
            </label>
            <label className="lpa-field">
              <span className="flabel">
                Allowed token contracts (C…, comma or space separated, optional)
              </span>
              <textarea
                rows={2}
                value={allowedTokens}
                onChange={(e) => setAllowedTokens(e.target.value)}
                placeholder="CB… CD…"
              />
            </label>
          </div>
        </>
      )}

      {template.type === "verified_only" && (
        <div className="flex flex-col gap-3" data-testid="provenance-mode">
          <p className="m-0! text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
            Restrict this account to contracts with <em>verified source provenance</em>. Verified
            means the deployed code was reproduced from inspectable, attributable source — not that
            it is audited, benign or safe. Enforced by the policy contract on-chain; your passkey
            can detach it at any time from Settings (the recovery path if the registry is
            unavailable).
          </p>
          <label className="lpa-field">
            <span className="flabel">Mode</span>
            <select
              value={provenanceMode}
              onChange={(e) => setProvenanceMode(e.target.value as "strict" | "trusted_publishers")}
            >
              <option value="strict">Strict — any live attestation</option>
              <option value="trusted_publishers">Trusted publishers only</option>
            </select>
          </label>
          {provenanceMode === "trusted_publishers" && (
            <label className="lpa-field">
              <span className="flabel">Trusted publishers (e.g. github.com/vellar-wallet)</span>
              <textarea
                rows={3}
                value={trustedPublishers}
                onChange={(e) => setTrustedPublishers(e.target.value)}
                placeholder="github.com/vellar-wallet"
              />
            </label>
          )}
        </div>
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
  attachedPolicies = [],
  onPolicyAttached,
  onPolicyDetached,
  onDone,
}: {
  policy: GeneratedPolicy;
  session: WalletSession;
  attachedPolicies?: AttachedPolicyRecord[];
  onPolicyAttached?: (record: AttachedPolicyRecord) => void;
  onPolicyDetached?: (contractId: string) => void;
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
  const definition = policy.definition as PolicyDefinition;
  const safetyRules =
    enforcement.kind === "policy-contract" &&
    enforcement.constructorArgs &&
    "rules" in enforcement.constructorArgs &&
    enforcement.constructorArgs.rules
      ? (enforcement.constructorArgs.rules as {
          maxSingleTransfer: Array<{ token: string; amountBaseUnits: string }>;
          allowedTokens: string[] | null;
        })
      : undefined;
  const busy = state.name === "simulating" || state.name === "deploying";
  const conflictWarnings = detectPolicyConflicts(policy, attachedPolicies);

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
      onPolicyAttached?.({
        id: policy.id,
        contractId: result.contractId,
        definition: policy.definition,
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
      onPolicyDetached?.(contractId);
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
          Enforced on-chain against the attestation registry
          {definition.provenance?.mode === "trusted_publishers"
            ? `, restricted to ${definition.provenance.trustedPublishers?.length ?? 0} trusted publisher(s)`
            : ""}
          . Verified means reproducible, attributable source provenance — not audited, benign or
          safe. If the registry is unavailable the policy fails closed; detach it from Settings to
          recover.
        </div>
      )}

      {safetyRules && (
        <div
          className="lpa-well text-[13px] leading-relaxed text-[var(--lp-ink-soft)]"
          data-testid="review-safety-rules"
        >
          <strong>Safety rules enforced on-chain</strong> for token transfers from this account:
          <ul className="m-0 mt-1 pl-4.5">
            {safetyRules.maxSingleTransfer.map((r) => (
              <li key={r.token}>
                No single transfer of {r.token.slice(0, 6)}…{r.token.slice(-6)} above{" "}
                {stroopsToXlm(r.amountBaseUnits)} units.
              </li>
            ))}
            {safetyRules.allowedTokens && (
              <li>
                Only these token contracts:{" "}
                {safetyRules.allowedTokens.map((t) => `${t.slice(0, 6)}…${t.slice(-6)}`).join(", ")}
                .
              </li>
            )}
          </ul>
          Denominated in token units, never USD. Scoped to the transfer pattern the policy
          understands — not a universal firewall.
        </div>
      )}

      {conflictWarnings.length > 0 && state.name !== "done" && state.name !== "detached" && (
        <div
          role="status"
          data-testid="policy-conflict-warning"
          className="lpa-well border-l-[3px]! border-l-[var(--lp-sun)]! text-[13px] leading-relaxed text-[var(--lp-ink-soft)]"
        >
          <strong className="block text-[var(--lp-ink)]">
            Potential policy conflict with an already-attached policy
          </strong>
          <ul className="m-0 mt-1.5 pl-4.5">
            {conflictWarnings.map((warning, i) => (
              <li key={`${warning.attachedType}-${warning.attachedContractId ?? i}`}>
                {warning.message}
              </li>
            ))}
          </ul>
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
