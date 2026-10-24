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

        {tab === "explore" ? <Explorer /> : <SubmitForm />}
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

function Explorer() {
  const [contractId, setContractId] = useState("");
  const [records, setRecords] = useState<PublicVerificationRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const valid = isContractId(contractId);

  async function lookup() {
    setError(null);
    setRecords(null);
    if (!valid) {
      setError("Enter a valid contract address (starts with C).");
      return;
    }
    setLoading(true);
    try {
      const history = await getVerificationHistory(contractId.trim());
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

      {error && <p className="lpa-bad">{error}</p>}

      {records && records.length === 0 && <EmptyHistory />}

      {records && records.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <TrustBadge status={latest!.status} />
            <span className="text-sm text-[var(--lp-ink-soft)]">
              {latest!.status === "failed"
                ? "The latest verification attempt failed — see the record below for the reason."
                : `${records.length} verification attempt${records.length > 1 ? "s" : ""}`}
            </span>
          </div>

          {records.map((r) => (
            <RecordCard key={r.id} record={r} />
          ))}
        </div>
      )}
    </section>
  );
}

// Zero verification history is a distinct state from a failed verification:
// nothing has ever been submitted for this contract id. A failed record means
// a rebuild was attempted and did not match. The empty state must not read as
// an error (#569).
function EmptyHistory() {
  return (
    <section
      className="lpa-panel flex flex-col items-center gap-3 py-8 text-center"
      data-testid="verify-empty-state"
    >
      <svg
        width="72"
        height="72"
        viewBox="0 0 72 72"
        fill="none"
        aria-hidden="true"
        className="opacity-70"
      >
        <rect
          x="18"
          y="10"
          width="30"
          height="40"
          rx="3"
          stroke="var(--lp-ink-faint)"
          strokeWidth="2"
        />
        <path
          d="M25 22h16M25 30h16M25 38h10"
          stroke="var(--lp-ink-faint)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="48" cy="48" r="12" stroke="var(--lp-ink-faint)" strokeWidth="2" />
        <path d="M57 57l7 7" stroke="var(--lp-ink-faint)" strokeWidth="2" strokeLinecap="round" />
        <path d="M44 48h8" stroke="var(--lp-ink-faint)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <h2 className="m-0! text-lg">No verification history</h2>
      <p className="m-0! max-w-[420px] text-sm leading-relaxed text-[var(--lp-ink-soft)]">
        Nothing has been submitted for this contract yet — it has not failed verification, it has
        simply never been checked. Submit its source on the &quot;Submit for verification&quot; tab
        to start a deterministic rebuild.
      </p>
    </section>
  );
}

function RecordCard({ record }: { record: PublicVerificationRecord }) {
  return (
    <article className="lpa-panel flex flex-col gap-2">
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
