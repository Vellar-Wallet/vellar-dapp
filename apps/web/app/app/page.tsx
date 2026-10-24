"use client";

import Link from "next/link";
import { useState } from "react";
import { Eyebrow, Frame, LpActionButton } from "../landing/ui";
import { OnboardingActions } from "../onboarding-actions";
import { useWalletSession } from "@/lib/wallet-context";
import { getInjectedProvider, pairExtension } from "@/lib/extension-pairing";
import "../landing/landing.css";
import "@/components/app.css";

// Wallet entry (/app): passkey onboarding (design.md §7) on the
// "paper & signals" system. The marketing landing lives at /.

export default function AppEntry({
  onExtensionAction,
}: {
  /** Optional extension action override for testing extension-dependent operations. */
  onExtensionAction?: () => Promise<unknown>;
} = {}) {
  const session = useWalletSession();
  const [extensionError, setExtensionError] = useState<string | null>(null);
  const [needsRepair, setNeedsRepair] = useState(false);
  const [repairSuccess, setRepairSuccess] = useState(false);
  const [repairing, setRepairing] = useState(false);

  async function handleExtensionAction() {
    setExtensionError(null);
    setRepairSuccess(false);

    const provider = getInjectedProvider();
    if (!provider) {
      setNeedsRepair(true);
      setExtensionError(
        "The paired extension is not responding or has been uninstalled. Please re-pair your extension.",
      );
      return;
    }

    try {
      if (onExtensionAction) {
        await onExtensionAction();
      } else if (session) {
        await provider.pairStatus({
          address: session.accountId,
          network: session.network,
        });
      }
    } catch {
      setNeedsRepair(true);
      setExtensionError(
        "The paired extension is not responding or has been uninstalled. Please re-pair your extension.",
      );
    }
  }

  async function handleRepair() {
    setRepairing(true);
    setExtensionError(null);

    const provider = getInjectedProvider();
    if (!provider) {
      setNeedsRepair(true);
      setExtensionError(
        "Extension not detected in this browser. Install the Vellar extension, then retry.",
      );
      setRepairing(false);
      return;
    }

    try {
      if (session) {
        await pairExtension(session);
      }
      setNeedsRepair(false);
      setRepairSuccess(true);
    } catch (err) {
      setExtensionError(
        err instanceof Error ? err.message : "Re-pairing failed. Try again.",
      );
    } finally {
      setRepairing(false);
    }
  }

  return (
    <main className="lp lpa lpa-auth">
      <Link
        href="/"
        className="font-[family-name:var(--lp-mono)] text-xs font-bold text-[var(--lp-ink-faint)]"
      >
        ← vellar.xyz
      </Link>
      <div className="mx-auto mt-12 max-w-[560px] text-center">
        <Eyebrow>Wallet · testnet</Eyebrow>
        <h1 className="mt-5! text-[length:var(--lp-fs-h2)]! tracking-[-0.02em]!">
          Step into your wallet.
        </h1>
        <p className="mx-auto mt-4! max-w-[46ch] text-base leading-relaxed text-[var(--lp-ink-soft)]">
          Create a smart account with a passkey, or sign back in with the one you already have. No
          seed phrase, no password, just you.
        </p>
      </div>

      <button
        type="button"
        data-testid="trigger-extension-action"
        className="sr-only"
        onClick={() => void handleExtensionAction()}
      >
        Attempt extension action
      </button>

      {session && (
        <div className="mx-auto mt-4 flex justify-center">
          <LpActionButton
            variant="outline"
            size="sm"
            onClick={() => void handleExtensionAction()}
          >
            Attempt extension action
          </LpActionButton>
        </div>
      )}

      {needsRepair && (
        <div
          role="alert"
          className="lpa-well mx-auto mt-6 max-w-[480px] flex flex-col items-center gap-2.5 text-center"
          data-testid="extension-repair-prompt"
        >
          <span className="lpa-bad font-bold">Extension disconnected</span>
          <p className="text-sm text-[var(--lp-ink-soft)]">
            {extensionError ??
              "The paired extension is not responding or has been uninstalled. Please re-pair your extension."}
          </p>
          <LpActionButton
            size="sm"
            onClick={() => void handleRepair()}
            disabled={repairing}
          >
            {repairing ? "Re-pairing…" : "Re-pair extension"}
          </LpActionButton>
        </div>
      )}

      {repairSuccess && (
        <div
          className="lpa-well mx-auto mt-6 max-w-[480px] text-center"
          data-testid="extension-repaired-banner"
        >
          <span className="lpa-ok font-bold">✓ Extension re-paired successfully</span>
        </div>
      )}

      <Frame className="mx-auto mt-9 max-w-[480px]">
        <div className="lpa-panel">
          <OnboardingActions />
        </div>
      </Frame>
    </main>
  );
}
