"use client";

import { useEffect, useRef, useState } from "react";
import type { CleanupPlan } from "@vela/types";
import { AppShell } from "@/components/app-shell";
import {
  buildMerge,
  executeCleanup,
  labSignUrl,
  planCleanup,
  watchTransaction,
  type CleanupStep,
} from "@/lib/lifecycle";

// Guided cleanup wizard (technical-doc.md §5.6, §7.7; idea.md §6.4 flow +
// §19 decision 4: explicit review, never one-click). VELA plans and watches;
// the user signs each UNSIGNED transaction in the wallet that holds the old
// account's key (decisions.md option A). Styling is intentionally utilitarian
// pending the design-system overhaul.

type Wizard =
  | { stage: "input" }
  | { stage: "plan"; plan: CleanupPlan }
  | { stage: "cleanup"; step: CleanupStep; watching: boolean; timedOut: boolean }
  | { stage: "merge"; step: CleanupStep; watching: boolean; timedOut: boolean }
  | { stage: "done" };

export default function Cleanup() {
  const [accountId, setAccountId] = useState("");
  const [destination, setDestination] = useState("");
  const [wizard, setWizard] = useState<Wizard>({ stage: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    [],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const inspect = () =>
    run(async () => {
      const { plan } = await planCleanup(accountId.trim(), destination.trim());
      setWizard({ stage: "plan", plan });
    });

  const startCleanup = () =>
    run(async () => {
      const { steps } = await executeCleanup(accountId.trim(), destination.trim());
      if (steps.length === 0) return startMerge();
      const step = steps[0]!;
      setWizard({ stage: "cleanup", step, watching: true, timedOut: false });
      void watch(step, "cleanup");
    });

  const startMerge = () =>
    run(async () => {
      const { step } = await buildMerge(accountId.trim(), destination.trim());
      setWizard({ stage: "merge", step, watching: true, timedOut: false });
      void watch(step, "merge");
    });

  async function watch(step: CleanupStep, stage: "cleanup" | "merge") {
    const seen = await watchTransaction(step.hash, { cancelled: () => cancelledRef.current });
    if (cancelledRef.current) return;
    if (!seen) {
      setWizard({ stage, step, watching: false, timedOut: true });
      return;
    }
    if (stage === "cleanup") await startMerge();
    else setWizard({ stage: "done" });
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 22 }}>
        <header>
          <h1 style={{ fontSize: "clamp(1.8rem,4vw,2.4rem)" }}>Close an old account</h1>
          <p
            style={{
              marginTop: 12,
              maxWidth: 620,
              fontSize: 15,
              color: "var(--muted)",
              lineHeight: 1.6,
            }}
          >
            Inspect a classic (G…) Stellar account, clear everything blocking its closure, and merge
            its XLM into another account. Vellar prepares each transaction — you sign in the wallet
            that holds the old account&apos;s key.
          </p>
        </header>

        {wizard.stage === "input" && (
          <section
            className="neo"
            style={{
              padding: 22,
              maxWidth: 560,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <label className="form-field">
              <span className="flabel">Old account to close (G…)</span>
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="G..."
              />
            </label>
            <label className="form-field">
              <span className="flabel">Destination for the reclaimed XLM (G…)</span>
              <input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="G... (classic account, not your smart wallet)"
              />
            </label>
            <button
              onClick={() => void inspect()}
              disabled={busy || !accountId.trim() || !destination.trim()}
              className="btn btn-signal"
              style={{ alignSelf: "flex-start" }}
            >
              {busy ? "Inspecting…" : "Inspect account"}
            </button>
          </section>
        )}

        {wizard.stage === "plan" && (
          <section
            className="neo"
            style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}
          >
            <span className="eyebrow">Cleanup plan</span>
            {wizard.plan.mergeReady ? (
              <span
                className="verified"
                style={{ alignSelf: "flex-start", color: "var(--signal)" }}
              >
                ✓ Nothing blocks this account — it can be merged in a single transaction
              </span>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {wizard.plan.blockers.map((blocker, i) => (
                  <li key={i} className="neo-inset" style={{ fontSize: 14, padding: "14px 16px" }}>
                    <span
                      className="lbl"
                      style={{
                        marginRight: 8,
                        background: "rgba(255,255,255,0.06)",
                        borderRadius: 8,
                        padding: "2px 8px",
                      }}
                    >
                      {blocker.type}
                    </span>
                    {blocker.description}
                    <p style={{ marginTop: 6, fontSize: 12, color: "var(--muted2)" }}>
                      {blocker.actionRequired}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p style={{ fontSize: 12, color: "var(--muted2)" }}>
              Estimated transactions: {wizard.plan.estimatedTransactions}
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={() => void (wizard.plan.mergeReady ? startMerge() : startCleanup())}
                disabled={busy}
                className="btn btn-signal"
              >
                {wizard.plan.mergeReady ? "Proceed to merge" : "Start cleanup"}
              </button>
              <button
                onClick={() => setWizard({ stage: "input" })}
                disabled={busy}
                className="btn btn-dark"
              >
                Back
              </button>
            </div>
          </section>
        )}

        {(wizard.stage === "cleanup" || wizard.stage === "merge") && (
          <SigningStepCard
            step={wizard.step}
            isMerge={wizard.stage === "merge"}
            watching={wizard.watching}
            timedOut={wizard.timedOut}
            onKeepWaiting={() => {
              setWizard({ ...wizard, watching: true, timedOut: false });
              void watch(wizard.step, wizard.stage);
            }}
          />
        )}

        {wizard.stage === "done" && (
          <section
            className="neo"
            style={{ padding: 22, display: "flex", flexDirection: "column" }}
          >
            <span className="verified" style={{ color: "var(--signal)" }}>
              ✓ Account closed — its entire XLM balance now lives at the destination
            </span>
            <div>
              <button
                onClick={() => setWizard({ stage: "input" })}
                className="btn btn-dark btn-sm"
                style={{ marginTop: 14 }}
              >
                Clean up another account
              </button>
            </div>
          </section>
        )}

        {error && (
          <p role="alert" style={{ fontSize: 14, color: "var(--negative)" }}>
            {error}
          </p>
        )}
      </div>
    </AppShell>
  );
}

function SigningStepCard({
  step,
  isMerge,
  watching,
  timedOut,
  onKeepWaiting,
}: {
  step: CleanupStep;
  isMerge: boolean;
  watching: boolean;
  timedOut: boolean;
  onKeepWaiting: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <section
      className="neo"
      style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <span className="eyebrow">{step.title}</span>
      <p style={{ fontSize: 14, color: "var(--muted)" }}>{step.description}</p>
      {isMerge && (
        <p
          className="neo-inset"
          style={{ fontSize: 14, color: "var(--lime)", padding: "14px 16px" }}
        >
          Final step: merging closes the account permanently. Review carefully before signing.
        </p>
      )}
      <textarea
        readOnly
        value={step.xdr}
        rows={4}
        className="neo-inset mono"
        style={{ width: "100%", fontSize: 12, color: "var(--muted2)", resize: "vertical" }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(step.xdr).then(() => setCopied(true));
          }}
          className="btn btn-dark btn-sm"
        >
          {copied ? "Copied" : "Copy XDR"}
        </button>
        <a
          href={labSignUrl(step.xdr)}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 14, color: "var(--signal)" }}
        >
          Open in Stellar Laboratory →
        </a>
      </div>
      {watching && (
        <p className="animate-pulse" style={{ fontSize: 14, color: "var(--muted2)" }}>
          Waiting for this transaction to appear on the network… sign and submit it in your wallet;
          this page advances automatically.
        </p>
      )}
      {timedOut && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14 }}>
          <p style={{ color: "var(--muted)" }}>Not seen on the network yet.</p>
          <button onClick={onKeepWaiting} className="btn btn-dark btn-sm">
            Keep waiting
          </button>
        </div>
      )}
    </section>
  );
}
