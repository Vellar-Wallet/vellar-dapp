"use client";

import { useEffect, useRef, useState } from "react";
import type { CleanupPlan } from "@vellar/types";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { CopyIcon } from "@/components/icons";
import {
  buildMerge,
  executeCleanup,
  labSignUrl,
  planCleanup,
  watchTransaction,
  type CleanupStep,
} from "@/lib/lifecycle";

// Guided cleanup wizard (technical-doc.md §5.6, §7.7; idea.md §6.4 flow +
// §19 decision 4: explicit review, never one-click). Vellar plans and watches;
// the user signs each UNSIGNED transaction in the wallet that holds the old
// account's key (decisions.md option A).

type Wizard =
  | { stage: "input" }
  | { stage: "plan"; plan: CleanupPlan }
  // Explicit confirmation before any signature: the itemized list of every
  // asset and trustline the plan affects, taken from the plan that will
  // actually execute (not a separately computed summary).
  | {
      stage: "confirm";
      plan: CleanupPlan;
      next: { kind: "cleanup"; steps: CleanupStep[] } | { kind: "merge" };
    }
  // Cleanup may be SPLIT into multiple transactions (>100 ops); `steps` holds
  // all of them and `index` is the one the user is signing now. The wizard walks
  // every step in order before it advances to the merge.
  | {
      stage: "cleanup";
      steps: CleanupStep[];
      index: number;
      watching: boolean;
      timedOut: boolean;
    }
  | { stage: "merge"; step: CleanupStep; watching: boolean; timedOut: boolean }
  | { stage: "done" };

export default function Cleanup() {
  const [accountId, setAccountId] = useState("");
  const [destination, setDestination] = useState("");
  const [wizard, setWizard] = useState<Wizard>({ stage: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // The unmount cleanup LATCHES cancelledRef, so every (re)mount must un-latch
  // it. React StrictMode mounts → unmounts → remounts, so without the reset the
  // remounted wizard is born cancelled: watch() bails out on its first check and
  // the flow stalls on "Waiting for this transaction…" forever.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

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

  // Execute first so the confirmation can itemize the plan that will actually
  // run, then hold at the confirm stage until the user approves.
  const startCleanup = () =>
    run(async () => {
      const { steps, plan } = await executeCleanup(accountId.trim(), destination.trim());
      if (steps.length === 0) {
        setWizard({ stage: "confirm", plan, next: { kind: "merge" } });
        return;
      }
      setWizard({ stage: "confirm", plan, next: { kind: "cleanup", steps } });
    });

  // From the plan stage: merge-ready plans skip execution and go to the same
  // confirmation (with the inspected plan) before any signature.
  const proceedFromPlan = () => {
    if (wizard.stage !== "plan") return;
    if (wizard.plan.mergeReady) {
      setWizard({ stage: "confirm", plan: wizard.plan, next: { kind: "merge" } });
    } else {
      void startCleanup();
    }
  };

  const confirmPlan = () => {
    if (wizard.stage !== "confirm") return;
    if (wizard.next.kind === "cleanup") {
      const { steps } = wizard.next;
      setWizard({ stage: "cleanup", steps, index: 0, watching: true, timedOut: false });
      void watchCleanup(steps, 0);
    } else {
      void startMerge();
    }
  };

  const startMerge = () =>
    run(async () => {
      const { step } = await buildMerge(accountId.trim(), destination.trim());
      setWizard({ stage: "merge", step, watching: true, timedOut: false });
      void watch(step, "merge");
    });

  // Walk each cleanup chunk in order: watch chunk `index`, and on confirmation
  // advance to the next chunk (not straight to merge) until all are signed —
  // only then build the merge. Dropping chunks 2..N left large accounts
  // partially cleaned and dead-ended at a 409-on-merge.
  async function watchCleanup(steps: CleanupStep[], index: number) {
    const step = steps[index]!;
    const seen = await watchTransaction(step.hash, { cancelled: () => cancelledRef.current });
    if (cancelledRef.current) return;
    if (!seen) {
      setWizard({ stage: "cleanup", steps, index, watching: false, timedOut: true });
      return;
    }
    const next = index + 1;
    if (next < steps.length) {
      setWizard({ stage: "cleanup", steps, index: next, watching: true, timedOut: false });
      void watchCleanup(steps, next);
    } else {
      await startMerge();
    }
  }

  async function watch(step: CleanupStep, stage: "merge") {
    const seen = await watchTransaction(step.hash, { cancelled: () => cancelledRef.current });
    if (cancelledRef.current) return;
    if (!seen) {
      setWizard({ stage, step, watching: false, timedOut: true });
      return;
    }
    setWizard({ stage: "done" });
  }

  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <header>
          <h1>Close an old account</h1>
          <p className="mt-3! max-w-[620px] text-[15px] leading-relaxed text-[var(--lp-ink-soft)]">
            Inspect a classic (G…) Stellar account, clear everything blocking its closure, and merge
            its XLM into another account. Vellar prepares each transaction — you sign in the wallet
            that holds the old account&apos;s key.
          </p>
        </header>

        {wizard.stage === "input" && (
          <section className="lpa-panel flex max-w-[560px] flex-col gap-3">
            <label className="lpa-field">
              <span className="flabel">Old account to close (G…)</span>
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="G..."
              />
            </label>
            <label className="lpa-field">
              <span className="flabel">Destination for the reclaimed XLM (G…)</span>
              <input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="G... (classic account, not your smart wallet)"
              />
            </label>
            <LpActionButton
              className="self-start"
              onClick={() => void inspect()}
              disabled={busy || !accountId.trim() || !destination.trim()}
            >
              {busy ? "Inspecting…" : "Inspect account"}
            </LpActionButton>
          </section>
        )}

        {wizard.stage === "plan" && (
          <section className="lpa-panel flex flex-col gap-4">
            <Eyebrow>Cleanup plan</Eyebrow>
            {wizard.plan.mergeReady ? (
              <span className="lpa-ok self-start text-sm font-bold">
                ✓ Nothing blocks this account — it can be merged in a single transaction
              </span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {wizard.plan.blockers.map((blocker, i) => (
                  <li key={i} className="lpa-well text-sm">
                    <span className="mr-2 bg-[var(--lp-sun-soft)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                      {blocker.type}
                    </span>
                    {blocker.description}
                    <p className="mt-1.5! text-xs text-[var(--lp-ink-faint)]">
                      {blocker.actionRequired}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-[var(--lp-ink-faint)]">
              Estimated transactions: {wizard.plan.estimatedTransactions}
            </p>
            <div className="flex gap-3">
              <LpActionButton onClick={() => void proceedFromPlan()} disabled={busy}>
                {wizard.plan.mergeReady ? "Proceed to merge" : "Start cleanup"}
              </LpActionButton>
              <LpActionButton
                variant="outline"
                onClick={() => setWizard({ stage: "input" })}
                disabled={busy}
              >
                Back
              </LpActionButton>
            </div>
          </section>
        )}

        {wizard.stage === "confirm" && (
          <section className="lpa-panel flex flex-col gap-4">
            <Eyebrow>Confirm before signing</Eyebrow>
            <p className="text-sm text-[var(--lp-ink-soft)]">
              Every asset and trustline this plan affects is listed below. Check it carefully — this
              is the last review before you are asked to sign.
            </p>
            <PlanItemList plan={wizard.plan} />
            <div className="flex gap-3">
              <LpActionButton onClick={() => void confirmPlan()} disabled={busy}>
                Looks right — continue to signing
              </LpActionButton>
              <LpActionButton
                variant="outline"
                onClick={() => setWizard({ stage: "plan", plan: wizard.plan })}
                disabled={busy}
              >
                Back
              </LpActionButton>
            </div>
          </section>
        )}

        {wizard.stage === "cleanup" && (
          <SigningStepCard
            step={wizard.steps[wizard.index]!}
            isMerge={false}
            progress={
              wizard.steps.length > 1
                ? { current: wizard.index + 1, total: wizard.steps.length }
                : undefined
            }
            watching={wizard.watching}
            timedOut={wizard.timedOut}
            onKeepWaiting={() => {
              setWizard({ ...wizard, watching: true, timedOut: false });
              void watchCleanup(wizard.steps, wizard.index);
            }}
          />
        )}

        {wizard.stage === "merge" && (
          <SigningStepCard
            step={wizard.step}
            isMerge
            watching={wizard.watching}
            timedOut={wizard.timedOut}
            onKeepWaiting={() => {
              setWizard({ ...wizard, watching: true, timedOut: false });
              void watch(wizard.step, "merge");
            }}
          />
        )}

        {wizard.stage === "done" && (
          <section className="lpa-panel flex flex-col">
            <span className="lpa-ok text-sm font-bold">
              ✓ Account closed — its entire XLM balance now lives at the destination
            </span>
            <div>
              <LpActionButton
                variant="outline"
                size="sm"
                className="mt-3.5"
                onClick={() => setWizard({ stage: "input" })}
              >
                Clean up another account
              </LpActionButton>
            </div>
          </section>
        )}

        {error && (
          <p role="alert" className="lpa-bad text-sm">
            {error}
          </p>
        )}
      </div>
    </AppShell>
  );
}

/**
 * Itemized list of every asset/trustline (and other blocker) the plan affects.
 * Rendered from the plan object that will actually execute — never a separate
 * summary — so the user reviews exactly what the signatures will do. The list
 * scrolls when it outgrows the panel, so long trustline sets stay readable
 * without cutting items off.
 */
function PlanItemList({ plan }: { plan: CleanupPlan }) {
  const items = plan.blockers;
  if (items.length === 0) {
    return (
      <p className="lpa-well text-sm">
        No assets or trustlines are affected — this account is clear apart from the merge itself.
      </p>
    );
  }
  return (
    <ul
      data-testid="plan-item-list"
      className="lpa-well m-0 flex max-h-[240px] list-none flex-col gap-2 overflow-y-auto p-3"
    >
      {items.map((item, i) => (
        <li key={i} className="text-sm">
          <span className="mr-2 bg-[var(--lp-sun-soft)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
            {item.type}
          </span>
          {item.description}
          <p className="mt-1! text-xs text-[var(--lp-ink-faint)]">{item.actionRequired}</p>
        </li>
      ))}
    </ul>
  );
}

function SigningStepCard({
  step,
  isMerge,
  progress,
  watching,
  timedOut,
  onKeepWaiting,
}: {
  step: CleanupStep;
  isMerge: boolean;
  /** For a split cleanup: which transaction of how many. */
  progress?: { current: number; total: number };
  watching: boolean;
  timedOut: boolean;
  onKeepWaiting: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="lpa-panel flex flex-col gap-3">
      <Eyebrow>{step.title}</Eyebrow>
      {progress && (
        <p className="text-[13px] text-[var(--lp-ink-faint)]">
          Transaction {progress.current} of {progress.total} — sign and submit each in order.
        </p>
      )}
      <p className="text-sm text-[var(--lp-ink-soft)]">{step.description}</p>
      {isMerge && (
        <p className="lpa-well border-l-[3px]! border-l-[var(--lp-sun)]! text-sm">
          Final step: merging closes the account permanently. Review carefully before signing.
        </p>
      )}
      <textarea
        readOnly
        value={step.xdr}
        rows={4}
        className="lpa-well w-full resize-y font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]"
      />
      <div className="flex flex-wrap items-center gap-3.5">
        <LpActionButton
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(step.xdr).then(() => setCopied(true));
          }}
        >
          <CopyIcon /> {copied ? "Copied" : "Copy XDR"}
        </LpActionButton>
        <a
          href={labSignUrl(step.xdr)}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-bold underline decoration-[var(--lp-mint)] decoration-2 underline-offset-2"
        >
          Open in Stellar Laboratory →
        </a>
      </div>
      {watching && (
        <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">
          Waiting for this transaction to appear on the network… sign and submit it in your wallet;
          this page advances automatically.
        </p>
      )}
      {timedOut && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-[var(--lp-ink-soft)]">Not seen on the network yet.</p>
          <LpActionButton variant="outline" size="sm" onClick={onKeepWaiting}>
            Keep waiting
          </LpActionButton>
        </div>
      )}
    </section>
  );
}
