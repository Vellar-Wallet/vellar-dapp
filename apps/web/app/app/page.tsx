"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WalletSession } from "@vellar/types";
import {
  checkPairingStatus,
  getInjectedProvider,
  pairExtension,
  recallPairing,
} from "@/lib/extension-pairing";
import { walletErrorMessage } from "@/lib/messages";
import { useWalletSession } from "@/lib/wallet-context";
import { Eyebrow, Frame, LpActionButton } from "../landing/ui";
import { OnboardingActions } from "../onboarding-actions";
import "../landing/landing.css";
import "@/components/app.css";

// Wallet entry (/app): passkey onboarding (design.md §7) on the
// "paper & signals" system, plus paired-extension health & mid-session
// uninstall/reinstall recovery (#574). The marketing landing lives at /.

export const EXTENSION_PROBE_TIMEOUT_MS = 3_000;

export function isExtensionDisconnectedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /extension.*not installed|context invalidated|receiving end does not exist|disconnected|message port closed|timed out/i.test(
    msg,
  );
}

export async function probePairedExtension(
  session: WalletSession,
  timeoutMs: number = EXTENSION_PROBE_TIMEOUT_MS,
): Promise<"paired" | "disconnected" | "unpaired"> {
  const provider = getInjectedProvider();
  const remembered = recallPairing(session.accountId);

  if (!provider) {
    return remembered ? "disconnected" : "unpaired";
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const statusPromise = provider.pairStatus({
      address: session.accountId,
      network: session.network,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Extension request timed out")), timeoutMs);
    });
    const { paired } = await Promise.race([statusPromise, timeoutPromise]);
    if (paired) return "paired";
    return remembered ? "disconnected" : "unpaired";
  } catch {
    return "disconnected";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ExtensionRecoveryState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "paired"; expiresAt?: string; hash?: string }
  | { step: "needs-repair"; reason: string }
  | { step: "repairing" }
  | { step: "error"; message: string };

export default function AppEntry() {
  const session = useWalletSession();

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
      <Frame className="mx-auto mt-9 max-w-[480px]">
        <div className="lpa-panel">
          <OnboardingActions />
          {session && <ExtensionReconnectSection session={session} />}
        </div>
      </Frame>
    </main>
  );
}

function ExtensionReconnectSection({ session }: { session: WalletSession }) {
  const [state, setState] = useState<ExtensionRecoveryState>(() => {
    const remembered = recallPairing(session.accountId);
    if (remembered) {
      return {
        step: "paired",
        expiresAt: remembered.expiresAt,
        hash: remembered.hash,
      };
    }
    return { step: "idle" };
  });

  useEffect(() => {
    const provider = getInjectedProvider();
    const remembered = recallPairing(session.accountId);
    if (!provider) {
      if (remembered) {
        setState({
          step: "needs-repair",
          reason:
            "The paired Vellar extension is no longer detected in this browser. Reinstall or re-enable it, then re-pair below without reloading the page.",
        });
      }
      return;
    }
    void checkPairingStatus(session).then((paired) => {
      if (paired) {
        setState({
          step: "paired",
          expiresAt: remembered?.expiresAt,
          hash: remembered?.hash,
        });
      } else if (remembered) {
        setState({
          step: "needs-repair",
          reason:
            "Your browser extension lost its pairing state (for example after being reinstalled). Re-pair it to continue using extension signing in this session.",
        });
      }
    });
  }, [session]);

  async function verifyOrUseExtension() {
    setState({ step: "checking" });
    const status = await probePairedExtension(session);
    if (status === "paired") {
      const remembered = recallPairing(session.accountId);
      setState({
        step: "paired",
        expiresAt: remembered?.expiresAt,
        hash: remembered?.hash,
      });
      return;
    }
    setState({
      step: "needs-repair",
      reason:
        getInjectedProvider() === undefined
          ? "The paired Vellar extension was uninstalled or disabled mid-session. Reinstall it, then click Re-pair extension to recover without reloading."
          : "The Vellar extension is no longer paired or stopped responding. Re-pair it with your passkey to restore extension signing.",
    });
  }

  async function handleRepair() {
    const provider = getInjectedProvider();
    if (!provider) {
      setState({
        step: "needs-repair",
        reason:
          "The Vellar extension is still not detected. Install or enable the extension in your browser, then click Re-pair extension again.",
      });
      return;
    }

    setState({ step: "repairing" });
    try {
      const result = await pairExtension(session);
      setState({
        step: "paired",
        expiresAt: result.expiresAt,
        hash: result.hash,
      });
    } catch (err) {
      if (isExtensionDisconnectedError(err)) {
        setState({
          step: "needs-repair",
          reason:
            "The extension disconnected before pairing completed. Make sure the Vellar extension is installed and active, then re-pair.",
        });
        return;
      }
      setState({ step: "error", message: walletErrorMessage(err) });
    }
  }

  return (
    <div
      className="mt-4 border-t border-[var(--lp-border)] pt-4 text-left"
      data-testid="extension-session-section"
    >
      <Eyebrow>Browser extension</Eyebrow>

      {(state.step === "idle" || state.step === "paired" || state.step === "checking") && (
        <div className="mt-2 flex flex-col gap-2.5 text-sm">
          {state.step === "paired" ? (
            <p className="lpa-ok m-0! font-bold" data-testid="extension-paired-status">
              ✓ Extension paired to this wallet
              {state.expiresAt
                ? ` · active until ${new Date(state.expiresAt).toLocaleString()}`
                : ""}
            </p>
          ) : (
            <p className="m-0! text-xs text-[var(--lp-ink-soft)]">
              Check or pair the Vellar browser extension for this wallet session.
            </p>
          )}
          <div className="flex flex-wrap gap-2.5">
            <LpActionButton
              variant="outline"
              size="sm"
              onClick={() => void verifyOrUseExtension()}
              disabled={state.step === "checking"}
            >
              {state.step === "checking" ? "Checking extension…" : "Check extension connection"}
            </LpActionButton>
          </div>
        </div>
      )}

      {(state.step === "needs-repair" || state.step === "repairing") && (
        <div
          role="status"
          data-testid="extension-reconnect-prompt"
          className="lpa-well mt-2.5 flex flex-col gap-2.5 text-sm"
        >
          <p className="m-0! font-bold text-[var(--lp-ink)]">
            Extension connection lost — re-pairing required
          </p>
          <p className="m-0! text-xs leading-relaxed text-[var(--lp-ink-soft)]">
            {state.step === "needs-repair"
              ? state.reason
              : "Re-pairing extension with your wallet…"}
          </p>
          <div className="flex gap-2.5">
            <LpActionButton
              size="sm"
              onClick={() => void handleRepair()}
              disabled={state.step === "repairing"}
            >
              {state.step === "repairing" ? "Re-pairing…" : "Re-pair extension"}
            </LpActionButton>
          </div>
        </div>
      )}

      {state.step === "error" && (
        <div className="mt-2.5 flex flex-col gap-2">
          <p role="alert" className="lpa-bad m-0! text-sm">
            {state.message}
          </p>
          <LpActionButton variant="outline" size="sm" onClick={() => void handleRepair()}>
            Re-pair extension
          </LpActionButton>
        </div>
      )}
    </div>
  );
}
