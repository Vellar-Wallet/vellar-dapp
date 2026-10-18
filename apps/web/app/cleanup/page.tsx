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
  // Cleanup may be SPLIT into multiple transactions (>100 ops); `steps` holds
  // all of them and `index` is the one the user is signing now. The wizard walks
  // every step in order before it advances to the merge.
  | {
      stage: "cleanup";
      plan: CleanupPlan;
      steps: CleanupStep[];
      index: number;
      watching: boolean;
      timedOut: boolean;
    }
  | {
      stage: "merge";
      plan?: CleanupPlan;
      step: CleanupStep;
      watching: boolean;
      timedOut: boolean;
    }
  | { stage: "done" };

export interface ItemizedCleanupEntry {
  kind: "trustline" | "balance" | "offer" | "data" | "native-merge";
  assetOrTarget: string;
  description: string;
  actionRequired: string;
}

/** Maximum visible rows before the itemized confirmation list scrolls. */
export const ITEMIZED_SCROLL_THRESHOLD = 5;

/**
 * Build the itemized list of every asset, trustline, and account entry affected
 * by a `CleanupPlan`. Generated directly from the `CleanupPlan` that executes
 * so the confirmation list cannot drift from the actual cleanup/merge steps.
 */
export function itemizeCleanupPlan(plan: CleanupPlan): ItemizedCleanupEntry[] {
  const entries: ItemizedCleanupEntry[] = plan.blockers.map((blocker) => {
    let assetOrTarget = blocker.description;
    if (blocker.type === "trustline") {
      const match = /^Trustline to\s+(.+)$/i.exec(blocker.description);
      if (match?.[1]) assetOrTarget = match[1].trim();
    } else if (blocker.type === "balance") {
      const match = /^Holds\s+\S+\s+(.+)$/i.exec(blocker.description);
      if (match?.[1]) assetOrTarget = match[1].trim();
    }
    return {
      kind: blocker.type,
      assetOrTarget,
      description: blocker.description,
      actionRequired: blocker.actionRequired,
    };
  });

  entries.push({
    kind: "native-merge",
    assetOrTarget: "XLM (native)",
    description: `Merge remaining XLM from ${plan.accountId} to ${plan.destination}`,
    actionRequired: `Transfer all remaining native XLM reserve into ${plan.destination}`,
  });

  return entries;
}

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

  const startCleanup = (inspectedPlan: CleanupPlan) =>
    run(async () => {
      const { steps, plan: executedPlan } = await executeCleanup(
        accountId.trim(),
        destination.trim(),
      );
      const activePlan = executedPlan ?? inspectedPlan;
      if (steps.length === 0) return startMerge(activePlan);
      setWizard({
        stage: "cleanup",
        plan: activePlan,
        steps,
        index: 0,
        watching: true,
        timedOut: false,
      });
      void watchCleanup(steps, 0, activePlan);
    });

  const startMerge = (activePlan?: CleanupPlan) =>
    run(async () => {
      const { step } = await buildMerge(accountId.trim(), destination.trim());
      setWizard({ stage: "merge", plan: activePlan, step, watching: true, timedOut: false });
      void watch(step, "merge", activePlan);
    });

  // Walk each cleanup chunk in order: watch chunk `index`, and on confirmation
  // advance to the next chunk (not straight to merge) until all are signed —
  // only then build the merge. Dropping chunks 2..N left large accounts
  // partially cleaned and dead-ended at a 409-on-merge.
  async function watchCleanup(steps: CleanupStep[], index: number, activePlan: CleanupPlan) {
    const step = steps[index]!;
    const seen = await watchTransaction(step.hash, { cancelled: () => cancelledRef.current });
    if (cancelledRef.current) return;
    if (!seen) {
      setWizard({
        stage: "cleanup",
        plan: activePlan,
        steps,
        index,
        watching: false,
        timedOut: true,
      });
      return;
    }
    const next = index + 1;
    if (next < steps.length) {
      setWizard({
        stage: "cleanup",
        plan: activePlan,
        steps,
        index: next,
        watching: true,
        timedOut: false,
      });
      void watchCleanup(steps, next, activePlan);
    } else {
      await startMerge(activePlan);
    }
  }

  async function watch(step: CleanupStep, stage: "merge", activePlan?: CleanupPlan) {
    const seen = await watchTransaction(step.hash, { cancelled: () => cancelledRef.current });
    if (cancelledRef.current) return;
    if (!seen) {
      setWizard({ stage, plan: activePlan, step, watching: false, timedOut: true });
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
              <ul
                data-testid="plan-blockers-list"
                data-scrollable={
                  wizard.plan.blockers.length > ITEMIZED_SCROLL_THRESHOLD ? "true" : "false"
                }
                tabIndex={wizard.plan.blockers.length > ITEMIZED_SCROLL_THRESHOLD ? 0 : undefined}
                className="m-0 flex max-h-60 list-none flex-col gap-2.5 overflow-y-auto p-0"
              >
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
              <LpActionButton
                onClick={() =>
                  void (wizard.plan.mergeReady
                    ? startMerge(wizard.plan)
                    : startCleanup(wizard.plan))
                }
                disabled={busy}
              >
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

        {wizard.stage === "cleanup" && (
          <SigningStepCard
            step={wizard.steps[wizard.index]!}
            plan={wizard.plan}
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
              void watchCleanup(wizard.steps, wizard.index, wizard.plan);
            }}
          />
        )}

        {wizard.stage === "merge" && (
          <SigningStepCard
            step={wizard.step}
            plan={wizard.plan}
            isMerge
            watching={wizard.watching}
            timedOut={wizard.timedOut}
            onKeepWaiting={() => {
              setWizard({ ...wizard, watching: true, timedOut: false });
              void watch(wizard.step, "merge", wizard.plan);
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

function SigningStepCard({
  step,
  plan,
  isMerge,
  progress,
  watching,
  timedOut,
  onKeepWaiting,
}: {
  step: CleanupStep;
  plan?: CleanupPlan;
  isMerge: boolean;
  /** For a split cleanup: which transaction of how many. */
  progress?: { current: number; total: number };
  watching: boolean;
  timedOut: boolean;
  onKeepWaiting: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const itemized = plan ? itemizeCleanupPlan(plan) : [];
  const scrollable = itemized.length > ITEMIZED_SCROLL_THRESHOLD;

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
      {plan && (
        <div
          role="region"
          aria-label="Affected assets and trustlines"
          data-testid="cleanup-itemized-confirmation"
          className="lpa-well flex flex-col gap-2"
        >
          <span className="flabel block font-[family-name:var(--lp-mono)] text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
            Affected assets &amp; trustlines ({itemized.length})
          </span>
          <ul
            data-testid="cleanup-itemized-list"
            data-scrollable={scrollable ? "true" : "false"}
            tabIndex={scrollable ? 0 : undefined}
            className="m-0 flex max-h-60 list-none flex-col gap-2 overflow-y-auto p-0"
          >
            {itemized.map((entry, idx) => (
              <li
                key={`${entry.kind}-${entry.assetOrTarget}-${idx}`}
                data-testid="cleanup-itemized-row"
                data-item-kind={entry.kind}
                className="flex flex-col gap-0.5 border-b border-[var(--lp-border)] pb-1.5 text-xs last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[var(--lp-ink)]">{entry.assetOrTarget}</span>
                  <span className="bg-[var(--lp-sun-soft)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                    {entry.kind}
                  </span>
                </div>
                <span className="text-[var(--lp-ink-soft)]">{entry.description}</span>
                <span className="text-[var(--lp-ink-faint)]">{entry.actionRequired}</span>
              </li>
            ))}
          </ul>
        </div>
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
