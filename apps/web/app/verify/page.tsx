"use client";

import { useState } from "react";
import { TrustBadge } from "@vela/ui";
import { VerificationApiError } from "@vela/verification-sdk";
import { AppShell } from "@/components/app-shell";
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
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 22 }}>
        <header>
          <h1 style={{ fontSize: "clamp(1.8rem,4vw,2.4rem)" }}>Contract verification</h1>
          <p style={{ color: "var(--neo-muted)", marginTop: 8, lineHeight: 1.6 }}>
            Check whether a deployed contract&apos;s on-chain code matches published source. We
            rebuild the source deterministically and compare it, byte for byte, to the deployed wasm
            — so a &quot;Verified&quot; badge means the code you can read is the code that runs.
          </p>
        </header>

        <div role="tablist" aria-label="Verification" style={{ display: "flex", gap: 8 }}>
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
      className={`btn btn-sm${active ? "" : " btn-ghost"}`}
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
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          aria-label="Contract address"
          placeholder="C… contract address"
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          className="input"
          style={{ flex: 1, minWidth: 260, fontFamily: "var(--mono, monospace)" }}
        />
        <button className="btn" onClick={lookup} disabled={loading || !contractId}>
          {loading ? "Checking…" : "Check"}
        </button>
      </div>

      {error && <p style={{ color: "var(--danger, #ef4444)" }}>{error}</p>}

      {records && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <TrustBadge status={latest?.status ?? "unverified"} />
            <span style={{ color: "var(--neo-muted)", fontSize: 14 }}>
              {records.length === 0
                ? "No verification has been submitted for this contract yet."
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

function RecordCard({ record }: { record: PublicVerificationRecord }) {
  const [showLog, setShowLog] = useState(false);
  return (
    <article
      className="neo-card"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
      >
        <TrustBadge status={record.status} size="sm" />
        <time style={{ color: "var(--neo-muted)", fontSize: 12 }}>
          {new Date(record.updatedAt).toLocaleString()}
        </time>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontSize: 13,
          margin: 0,
        }}
      >
        <dt style={{ color: "var(--neo-muted)" }}>Source</dt>
        <dd style={{ margin: 0 }}>
          {record.sourceType === "repo"
            ? `${record.repoUrl ?? "repo"} @ ${record.commitHash ?? "?"}`
            : "uploaded archive"}
        </dd>
        <dt style={{ color: "var(--neo-muted)" }}>Toolchain</dt>
        <dd style={{ margin: 0 }}>{record.toolchainVersion}</dd>
        {record.outputHash && (
          <>
            <dt style={{ color: "var(--neo-muted)" }}>Rebuilt hash</dt>
            <dd style={{ margin: 0, wordBreak: "break-all", fontFamily: "var(--mono, monospace)" }}>
              {record.outputHash}
            </dd>
          </>
        )}
        {record.deployedHash && (
          <>
            <dt style={{ color: "var(--neo-muted)" }}>Deployed hash</dt>
            <dd style={{ margin: 0, wordBreak: "break-all", fontFamily: "var(--mono, monospace)" }}>
              {record.deployedHash}
            </dd>
          </>
        )}
      </dl>
      {record.log && (
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowLog((s) => !s)}>
            {showLog ? "Hide build log" : "Show build log"}
          </button>
          {showLog && (
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                background: "var(--neo-bg, #111)",
                borderRadius: 8,
                fontSize: 12,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {record.log}
            </pre>
          )}
        </div>
      )}
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
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Contract address">
        <input
          className="input"
          placeholder="C…"
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          style={{ fontFamily: "var(--mono, monospace)" }}
        />
      </Field>

      <Field label="Source">
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="radio"
              name="sourceType"
              checked={sourceType === "repo"}
              onChange={() => setSourceType("repo")}
            />
            Git repository
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
              className="input"
              placeholder="https://github.com/org/contract"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Field>
          <Field label="Commit hash">
            <input
              className="input"
              placeholder="a1b2c3d…"
              value={commitHash}
              onChange={(e) => setCommitHash(e.target.value)}
              style={{ fontFamily: "var(--mono, monospace)" }}
            />
          </Field>
        </>
      ) : (
        <Field label="Archive reference">
          <input
            className="input"
            placeholder="archive://…"
            value={archiveRef}
            onChange={(e) => setArchiveRef(e.target.value)}
          />
        </Field>
      )}

      <Field label="Toolchain version">
        <input
          className="input"
          placeholder="1.81.0"
          value={toolchain}
          onChange={(e) => setToolchain(e.target.value)}
        />
      </Field>

      <Field label="Build flags (optional, space-separated)">
        <input
          className="input"
          placeholder="--release"
          value={flags}
          onChange={(e) => setFlags(e.target.value)}
        />
      </Field>

      {error && <p style={{ color: "var(--danger, #ef4444)" }}>{error}</p>}

      <button className="btn" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : "Submit for verification"}
      </button>

      {result && (
        <div
          className="neo-card"
          style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <TrustBadge status={result.status} />
            <strong>Submission received</strong>
          </div>
          <p style={{ color: "var(--neo-muted)", fontSize: 14, margin: 0 }}>
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
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
