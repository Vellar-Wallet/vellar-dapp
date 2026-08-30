"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  detectPasskeySupport,
  environmentFromWindow,
  isUserCancellation,
  type PasskeySupport,
} from "@vellar/passkey";
import type { PasskeyEnvironment } from "@vellar/passkey";
import { LpActionButton } from "@/app/landing/ui";
import { walletConfig } from "@/lib/config";
import { walletErrorMessage } from "@/lib/messages";
import { useWalletActions } from "@/lib/wallet-context";
import { getAnalyticsTracker, walletCreationEvents, walletSignInEvents } from "@/lib/analytics";

// Onboarding entry points (technical-doc.md §7.1): create wallet with a new
// passkey, or reconnect with an existing one. Advanced flows live behind the
// dashboard once connected.

export function OnboardingActions({
  environment,
}: {
  /** Test seam: overrides the browser environment used for support detection. */
  environment?: PasskeyEnvironment;
}) {
  const router = useRouter();
  const actions = useWalletActions();
  const config = walletConfig();

  const [support, setSupport] = useState<PasskeySupport | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<"create" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupport(detectPasskeySupport(environment ?? environmentFromWindow(window)));
    // Emit funnel start event when component mounts (first load of onboarding page)
    walletCreationEvents.funnelStart({
      network: config.network,
    });
  }, [environment, config.network]);

  const unsupported = support !== null && !support.supported;
  const disabled = busy !== null || unsupported;

  async function run(kind: "create" | "connect", action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);

    const context = { network: config.network };

    if (kind === "create") {
      walletCreationEvents.createInitiated({ hasUsername: !!username }, context);
    } else {
      walletSignInEvents.signInInitiated(context);
    }

    try {
      await action();

      // Emit success events before navigation
      if (kind === "create") {
        walletCreationEvents.passkeyConfirmed(context);
        // Session is populated by the wallet store after createWallet succeeds.
        // The dashboard component will emit funnelCompleted with full context.
        // Here we emit partial context; the dashboard fills in contractId/sessionId.
      } else {
        walletSignInEvents.signinPasskeyConfirmed(context);
        // Similar: dashboard will emit signin completion with full context
      }

      // Flush analytics before navigation
      await getAnalyticsTracker().flush();
      router.push("/dashboard");
    } catch (err) {
      // Changing your mind at the passkey prompt is not an error state.
      if (isUserCancellation(err)) {
        if (kind === "create") {
          walletCreationEvents.creationCancelled(context);
        }
        // Note: for sign-in, there's no explicit "cancelled" event (user may just be trying a different device)
      } else {
        const failureReason = walletErrorMessage(err);
        if (kind === "create") {
          walletCreationEvents.creationFailed(
            { failureReason, step: "passkey" },
            context,
          );
        } else {
          walletSignInEvents.signinFailed({ failureReason }, context);
        }
        setError(failureReason);
      }

      // Flush analytics for error case
      await getAnalyticsTracker().flush();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-left">
      <label className="lpa-field">
        <span className="flabel">Wallet name (optional)</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. dumto"
          disabled={disabled}
        />
      </label>
      <div className="flex gap-3">
        <LpActionButton
          className="flex-1"
          onClick={() =>
            void run("create", () =>
              actions.createWallet({
                username: username || undefined,
                network: config.network,
              }),
            )
          }
          disabled={disabled}
        >
          {busy === "create" ? "Creating…" : "Create wallet"}
        </LpActionButton>
        <LpActionButton
          variant="outline"
          className="flex-1"
          onClick={() => void run("connect", () => actions.connectWallet(config.network))}
          disabled={disabled}
        >
          {busy === "connect" ? "Signing in…" : "Sign in"}
        </LpActionButton>
      </div>
      {unsupported && (
        <p role="alert" className="lpa-bad text-[13px]">
          {support?.supported === false && support.reason === "insecure-context"
            ? "Passkeys need a secure (HTTPS) connection."
            : "This browser doesn't support passkeys. Try a current version of Chrome, Safari, Edge, or Firefox."}
        </p>
      )}
      {error && (
        <p role="alert" className="lpa-bad text-[13px]">
          {error}
        </p>
      )}
    </div>
  );
}
