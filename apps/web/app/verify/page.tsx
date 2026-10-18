"use client";

import { useState } from "react";
import { TrustBadge } from "@vellar/ui";
import { VerificationApiError } from "@vellar/verification-sdk";
import { AppShell } from "@/components/app-shell";
import { LpActionButton, cx } from "@/app/landing/ui";
import {
  getVerificationHistory,
  isContractId,
  submitVerification,
  type PublicVerificationRecord,
  type SubmitVerificationInput,
} from "@/lib/verification";

// Contract verification explorer (technical-doc.md §5.5, §7.6; idea.md §6.3).
// Two jobs on one page:
//   • Explorer  — look up a contract id → show its verification history + trust
//     badge (the public trust surface; anyone can check any contract).
//   • Submit    — a developer submits source (repo+commit or upload ref) +
//     build metadata to queue a deterministic rebuild.
// Both talk to the gateway through the shared verification-sdk client.

type Tab = "explore" | "submit";

export default function Verify() {
  const [tab, setTab] = useState<Tab>("explore");

  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <header>
          <h1>Contract verification</h1>
          <p className="mt-2! leading-relaxed text-[var(--lp-ink-soft)]">
            Check whether a deployed contract&apos;s on-chain code matches published source. We
            rebuild the source deterministically and compare it, byte for byte, to the deployed
            wasm, so a &quot;Verified&quot; badge means the code you can read is the code that runs.
          </p>
        </header>

        <div role="tablist" aria-label="Verification" className="flex gap-2">
          <TabButton active={tab === "explore"} onClick={() => setTab("explore")}>
            Check a contract
          </TabButton>
          <TabButton active={tab === "submit"} onClick={() => setTab("submit")}>
            Submit for verification
          </TabButton>
        </div>

        {tab === "explore" ? (
          <Explorer onSubmitContract={() => setTab("submit")} />
        ) : (
          <SubmitForm />
        )}
      </div>
    </AppShell>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx("lp-btn", "lp-btn--sm", active ? "lp-btn--forest" : "lp-btn--outline")}
    >
      {children}
    </button>
  );
}

// --- Explorer ----------------------------------------------------------------

function Explorer({ onSubmitContract }: { onSubmitContract?: () => void }) {
  const [contractId, setContractId] = useState("");
  const [records, setRecords] = useState<PublicVerificationRecord[] | null>(null);
  const [checkedContractId, setCheckedContractId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const valid = isContractId(contractId);

  async function lookup() {
    setError(null);
    setRecords(null);
    setCheckedContractId(null);
    if (!valid) {
      setError("Enter a valid contract address (starts with C).");
      return;
    }
    const target = contractId.trim();
    setLoading(true);
    try {
      const history = await getVerificationHistory(target);
      setCheckedContractId(target);
      setRecords(history);
    } catch (err) {
      setError(err instanceof VerificationApiError ? err.message : "Lookup failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const latest = records?.[0];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Contract address"
          placeholder="C… contract address"
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          className="lpa-input min-w-[260px] flex-1 font-[family-name:var(--lp-mono)]"
        />
        <LpActionButton onClick={lookup} disabled={loading || !contractId}>
          {loading ? "Checking…" : "Check"}
        </LpActionButton>
      </div>

      {error && (
        <p role="alert" className="lpa-bad">
          {error}
        </p>
      )}

      {records && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <TrustBadge status={latest?.status ?? "unverified"} />
            <span className="text-sm text-[var(--lp-ink-soft)]">
              {records.length === 0
                ? "No verification has been submitted for this contract yet."
                : `${records.length} verification attempt${records.length > 1 ? "s" : ""}`}
            </span>
          </div>

          {records.length === 0 ? (
            <ZeroHistoryEmptyState
              contractId={checkedContractId ?? contractId.trim()}
              onSubmitContract={onSubmitContract}
            />
          ) : (
            records.map((r) => <RecordCard key={r.id} record={r} />)
          )}
        </div>
      )}
    </section>
  );
}

export function ZeroHistoryEmptyState({
  contractId,
  onSubmitContract,
}: {
  contractId: string;
  onSubmitContract?: () => void;
}) {
  return (
    <div
      data-testid="zero-history-empty-state"
      data-state="zero-history"
      className="lpa-panel flex flex-col items-start gap-3 border border-dashed border-[var(--lp-border)]"
    >
      <div className="flex items-center gap-3">
        <svg
          data-testid="zero-history-illustration"
          aria-hidden="true"
          width="44"
          height="44"
          viewBox="0 0 44 44"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="shrink-0 text-[var(--lp-ink-faint)]"
        >
          <rect
            x="6"
            y="5"
            width="24"
            height="30"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.75"
          />
          <line x1="11" y1="13" x2="25" y2="13" stroke="currentColor" strokeWidth="1.75" />
          <line x1="11" y1="19" x2="21" y2="19" stroke="currentColor" strokeWidth="1.75" />
          <line x1="11" y1="25" x2="17" y2="25" stroke="currentColor" strokeWidth="1.75" />
          <circle
            cx="29"
            cy="29"
            r="7"
            fill="var(--lp-paper, #fff)"
            stroke="currentColor"
            strokeWidth="1.75"
          />
          <line
            x1="34"
            y1="34"
            x2="39"
            y2="39"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <div>
          <strong className="block text-sm text-[var(--lp-ink)]">
            Zero verification history for this contract
          </strong>
          <span className="break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
            {contractId}
          </span>
        </div>
      </div>
      <p className="m-0! text-[13px] leading-relaxed text-[var(--lp-ink-soft)]">
        No source code has ever been submitted to the verification registry for this contract ID.
        Unlike a failed verification attempt — where a submitted build did not match the deployed
        on-chain Wasm — this contract simply has no verification records on file yet.
      </p>
      {onSubmitContract && (
        <LpActionButton variant="outline" size="sm" onClick={onSubmitContract}>
          Submit source for verification →
        </LpActionButton>
      )}
    </div>
  );
}

function RecordCard({ record }: { record: PublicVerificationRecord }) {
  return (
    <article
      data-testid="verification-record-card"
      data-status={record.status}
      className={cx(
        "lpa-panel flex flex-col gap-2",
        record.status === "failed" && "border-l-[3px]! border-l-[var(--lpa-bad)]!",
      )}
    >
      <div className="flex items-center justify-between gap-2.5">
        <TrustBadge status={record.status} size="sm" />
        <time className="text-xs text-[var(--lp-ink-faint)]">
          {new Date(record.updatedAt).toLocaleString()}
        </time>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-[var(--lp-ink-faint)]">Source</dt>
        <dd className="m-0">
          {record.sourceType === "repo"
            ? `${record.repoUrl ?? "repo"} @ ${record.commitHash ?? "?"}`
            : "uploaded archive"}
        </dd>
        <dt className="text-[var(--lp-ink-faint)]">Toolchain</dt>
        <dd className="m-0">{record.toolchainVersion}</dd>
        {record.outputHash && (
          <>
            <dt className="text-[var(--lp-ink-faint)]">Rebuilt hash</dt>
            <dd className="m-0 break-all font-[family-name:var(--lp-mono)]">{record.outputHash}</dd>
          </>
        )}
        {record.deployedHash && (
          <>
            <dt className="text-[var(--lp-ink-faint)]">Deployed hash</dt>
            <dd className="m-0 break-all font-[family-name:var(--lp-mono)]">
              {record.deployedHash}
            </dd>
          </>
        )}
      </dl>
      {/* H3/FIX 6 (#229): the raw build log is no longer exposed by the API — it
          leaked host paths / internal IPs. The server now returns a sanitized
          public `statusDetail` (e.g. "Build failed (clone_failed)."). */}
      {record.statusDetail && <p className="lpa-well mt-2! text-[13px]">{record.statusDetail}</p>}
    </article>
  );
}

// --- Submit form -------------------------------------------------------------

function SubmitForm() {
  const [sourceType, setSourceType] = useState<"repo" | "upload">("repo");
  const [contractId, setContractId] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [archiveRef, setArchiveRef] = useState("");
  const [toolchain, setToolchain] = useState("");
  const [flags, setFlags] = useState("");
  const [result, setResult] = useState<PublicVerificationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setResult(null);
    if (!isContractId(contractId)) {
      setError("Enter a valid contract address (starts with C).");
      return;
    }
    if (!toolchain.trim()) {
      setError("Toolchain version is required (it's part of a reproducible build).");
      return;
    }
    const input: SubmitVerificationInput = {
      contractId: contractId.trim(),
      sourceType,
      toolchainVersion: toolchain.trim(),
      buildFlags: flags.trim() ? flags.trim().split(/\s+/) : undefined,
      ...(sourceType === "repo"
        ? { repoUrl: repoUrl.trim(), commitHash: commitHash.trim() }
        : { sourceArchiveRef: archiveRef.trim() }),
    };
    setBusy(true);
    try {
      const record = await submitVerification(input);
      setResult(record);
    } catch (err) {
      setError(err instanceof VerificationApiError ? err.message : "Submission failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3.5">
      <Field label="Contract address">
        <input
          placeholder="C…"
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="font-[family-name:var(--lp-mono)]"
        />
      </Field>

      <Field label="Source">
        <div className="flex gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="sourceType"
              checked={sourceType === "repo"}
              onChange={() => setSourceType("repo")}
            />
            Git repository
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="sourceType"
              checked={sourceType === "upload"}
              onChange={() => setSourceType("upload")}
            />
            Uploaded archive
          </label>
        </div>
      </Field>

      {sourceType === "repo" ? (
        <>
          <Field label="Repository URL">
            <input
              placeholder="https://github.com/org/contract"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Field>
          <Field label="Commit hash">
            <input
              placeholder="a1b2c3d…"
              value={commitHash}
              onChange={(e) => setCommitHash(e.target.value)}
              className="font-[family-name:var(--lp-mono)]"
            />
          </Field>
        </>
      ) : (
        <Field label="Archive reference">
          <input
            placeholder="archive://…"
            value={archiveRef}
            onChange={(e) => setArchiveRef(e.target.value)}
          />
        </Field>
      )}

      <Field label="Toolchain version">
        <input
          placeholder="1.81.0"
          value={toolchain}
          onChange={(e) => setToolchain(e.target.value)}
        />
      </Field>

      <Field label="Build flags (optional, space-separated)">
        <input placeholder="--release" value={flags} onChange={(e) => setFlags(e.target.value)} />
      </Field>

      {error && <p className="lpa-bad">{error}</p>}

      <LpActionButton className="self-start" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : "Submit for verification"}
      </LpActionButton>

      {result && (
        <div className="lpa-panel flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <TrustBadge status={result.status} />
            <strong>Submission received</strong>
          </div>
          <p className="m-0! text-sm text-[var(--lp-ink-soft)]">
            Your contract is queued for a deterministic rebuild. Check its status any time on the
            &quot;Check a contract&quot; tab.
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="lpa-field">
      {<span className="flabel">{label}</span>}
      {children}
    </label>
  );
}
