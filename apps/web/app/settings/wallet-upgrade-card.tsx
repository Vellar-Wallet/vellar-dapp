"use client";

import { useState } from "react";
import type { WalletSession } from "@vellar/types";
import { isUserCancellation } from "@vellar/passkey";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { walletErrorMessage } from "@/lib/messages";
import { signerMutationErrorMessage } from "@/lib/signer-model";
import { trackTransaction } from "@/lib/track";
import { walletUpgradeErrorMessage } from "@/lib/wallet-upgrade";
import { useUpgradeWallet, useWalletVersion } from "@/lib/wallet-version";

// Wallet contract upgrade (open-work 5.1). When the app's pinned wallet wasm
// hash advances past what this account's contract runs, the account owner
// upgrades in place with one passkey approval — same address, same signers,
// same balances; only the contract code changes. The target is always the
// hash this app build is pinned to, never user input.

type State =
  | { step: "idle" }
  | { step: "approving" }
  | { step: "confirming"; hash: string }
  | { step: "done"; hash: string; toWasmHash: string }
  | { step: "error"; message: string };

export function WalletUpgradeCard({ session }: { session: WalletSession }) {
  const version = useWalletVersion(session.accountId, session.network);
  const upgrade = useUpgradeWallet(session.accountId, session.network, session.keyId);
  const [state, setState] = useState<State>({ step: "idle" });

  async function run() {
    setState({ step: "approving" });
    try {
      const result = await upgrade.mutateAsync();
      setState({ step: "confirming", hash: result.hash });
      const outcome = await trackTransaction(result.hash);
      if (outcome !== "success")
        throw new Error(`Transaction ${result.hash} failed on the network.`);
      setState({ step: "done", hash: result.hash, toWasmHash: result.toWasmHash });
      void version.refetch();
    } catch (err) {
      setState({ step: "error", message: describe(err) });
    }
  }

  const busy = state.step === "approving" || state.step === "confirming";
  const status = version.data;

  return (
    <section className="lpa-panel" aria-labelledby="wallet-upgrade-heading">
      <Eyebrow id="wallet-upgrade-heading">Wallet version</Eyebrow>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Your account is a smart contract. When Vellar ships a newer wallet contract, you can upgrade
        in place: the address, signers and balances stay the same — only the contract code changes.
        Upgrading needs one approval from your passkey.
      </p>

      {version.isPending && (
        <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">
          Checking wallet version…
        </p>
      )}

      {version.isError && (
        <div className="mt-3.5 flex items-center gap-3">
          <p role="alert" className="lpa-bad text-sm">
            Couldn&apos;t read the wallet contract version.
          </p>
          <LpActionButton variant="outline" size="sm" onClick={() => void version.refetch()}>
            Retry
          </LpActionButton>
        </div>
      )}

      {status && (
        <dl className="mt-3.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-[var(--lp-ink-faint)]">Running</dt>
          <dd className="m-0 break-all font-[family-name:var(--lp-mono)]">{status.currentHash}</dd>
          <dt className="text-[var(--lp-ink-faint)]">Latest</dt>
          <dd className="m-0 break-all font-[family-name:var(--lp-mono)]">{status.targetHash}</dd>
        </dl>
      )}

      {status?.state === "current" && state.step !== "done" && (
        <p className="lpa-ok mt-3! text-sm font-bold">✓ Your wallet is up to date</p>
      )}

      {status?.state === "upgrade-available" && state.step !== "done" && (
        <div className="mt-3.5 flex flex-col gap-2.5">
          <p className="m-0! text-sm text-[var(--lp-ink-soft)]">
            A newer wallet version is available on{" "}
            <strong className="uppercase">{session.network}</strong>.
          </p>
          <LpActionButton className="self-start" onClick={() => void run()} disabled={busy}>
            {state.step === "approving"
              ? "Approve with your passkey…"
              : state.step === "confirming"
                ? "Confirming on the network…"
                : "Upgrade wallet — approve with passkey"}
          </LpActionButton>
        </div>
      )}

      {state.step === "confirming" && (
        <p className="mt-2.5! break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
          tx {state.hash}
        </p>
      )}

      {state.step === "done" && (
        <div className="mt-3.5 flex flex-col gap-2 text-sm">
          <span className="lpa-ok font-bold">✓ Wallet upgraded on-chain</span>
          <p className="m-0! break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
            now running {state.toWasmHash} · tx {state.hash}
          </p>
        </div>
      )}

      {state.step === "error" && (
        <p role="alert" className="lpa-bad mt-2.5! text-sm">
          {state.message}
        </p>
      )}
    </section>
  );
}

function describe(err: unknown): string {
  if (isUserCancellation(err)) return "The passkey prompt was dismissed. Nothing was changed.";
  return walletUpgradeErrorMessage(err, signerMutationErrorMessage(err, walletErrorMessage(err)));
}
