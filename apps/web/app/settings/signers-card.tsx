"use client";

import { useState } from "react";
import type { WalletSession } from "@vellar/types";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { isUserCancellation } from "@vellar/passkey";
import { walletErrorMessage } from "@/lib/messages";
import { signerMutationErrorMessage } from "@/lib/signer-model";
import {
  canRevokeSigner,
  useRevokeSigner,
  useSigners,
  type SignerEntry,
  type SignerKind,
} from "@/lib/signers";
import { trackTransaction } from "@/lib/track";

// Signer management (#401): every signer on the account, read from chain,
// with on-chain revocation. This is the one place all signer kinds — human
// passkeys, extension device sessions, agent keys and policies — are managed;
// policy DETACH (the V3 / mainnet-blocker-#2 recovery path) is the "Detach"
// action on a policy row, wired to the same kit.remove(SignerKey.Policy)
// primitive the policy builder uses.

const KIND_LABEL: Record<SignerKind, string> = {
  passkey: "Passkey",
  "device-session": "Device session",
  agent: "Agent key",
  policy: "Policy",
  unknown: "Unrecognized signer",
};

const KIND_BLURB: Record<SignerKind, string> = {
  passkey:
    "A human-held passkey. Full control of the account, including adding and removing other signers.",
  "device-session":
    "The browser extension, paired as an expiring device signer. Approves dApp transactions until it expires.",
  agent:
    "A delegated ed25519 key. Its authority is bounded on-chain by the policies listed as required co-signers.",
  policy:
    "A policy contract attached as a standalone signer. It authorizes only what its rules allow; your passkey can detach it at any time without the policy's consent.",
  unknown:
    "This signer's key type isn't recognized by this version of the app. Its effect on the account cannot be determined here — check the account on-chain before revoking it.",
};

type RevokeState =
  | { step: "idle" }
  | { step: "confirm"; id: string }
  | { step: "approving"; id: string }
  | { step: "confirming"; id: string; hash: string }
  | { step: "done"; id: string; hash: string }
  | { step: "error"; id: string; message: string };

export function SignersCard({ session }: { session: WalletSession }) {
  const signers = useSigners(session.accountId, session.network, session.keyId);
  const revoke = useRevokeSigner(session.accountId, session.network, session.keyId);
  const [state, setState] = useState<RevokeState>({ step: "idle" });

  async function runRevoke(entry: SignerEntry) {
    setState({ step: "approving", id: entry.id });
    try {
      const { hash } = await revoke.mutateAsync(entry.key);
      setState({ step: "confirming", id: entry.id, hash });
      const result = await trackTransaction(hash);
      if (result !== "success") throw new Error(`Transaction ${hash} failed on the network.`);
      setState({ step: "done", id: entry.id, hash });
      await signers.refetch();
    } catch (err) {
      const message = isUserCancellation(err)
        ? "The passkey approval was dismissed. Nothing was changed."
        : signerMutationErrorMessage(err, walletErrorMessage(err));
      setState({ step: "error", id: entry.id, message });
    }
  }

  const entries = signers.data ?? [];

  return (
    <section className="lpa-panel" aria-labelledby="signers-heading">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow id="signers-heading">Signers on this account</Eyebrow>
        <LpActionButton
          variant="outline"
          size="sm"
          onClick={() => void signers.refetch()}
          disabled={signers.isFetching}
        >
          {signers.isFetching ? "Refreshing…" : "Refresh from chain"}
        </LpActionButton>
      </div>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Read live from the network ({session.network}). Anything added or revoked from another
        device appears here after a refresh. Every change below is an on-chain transaction approved
        with your passkey.
      </p>

      {signers.isPending && (
        <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading signers…</p>
      )}

      {signers.isError && (
        <div className="mt-3.5 flex items-center gap-3">
          <p role="alert" className="lpa-bad text-sm">
            Couldn&apos;t read the account&apos;s signers from the network.
          </p>
          <LpActionButton variant="outline" size="sm" onClick={() => void signers.refetch()}>
            Retry
          </LpActionButton>
        </div>
      )}

      {signers.data && (
        <ul className="mt-3.5 flex list-none flex-col gap-2.5 p-0">
          {entries.length === 0 && (
            <li className="text-sm text-[var(--lp-ink-faint)]">No signers found on-chain.</li>
          )}
          {entries.map((entry) => (
            <SignerRow
              key={entry.id}
              entry={entry}
              entries={entries}
              state={state}
              network={session.network}
              onRevoke={() => setState({ step: "confirm", id: entry.id })}
              onCancel={() => setState({ step: "idle" })}
              onConfirm={() => void runRevoke(entry)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SignerRow({
  entry,
  entries,
  state,
  network,
  onRevoke,
  onCancel,
  onConfirm,
}: {
  entry: SignerEntry;
  entries: SignerEntry[];
  state: RevokeState;
  network: string;
  onRevoke: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const mine = state.step !== "idle" && state.id === entry.id;
  const busy = state.step === "approving" || state.step === "confirming";
  const verdict = canRevokeSigner(entry, entries);
  const actionLabel = entry.kind === "policy" ? "Detach policy" : "Revoke";

  return (
    <li className="lpa-well flex flex-col gap-2.5" data-testid={`signer-${entry.kind}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 text-sm">
          <p className="flex flex-wrap items-center gap-2 text-[var(--lp-ink-soft)]">
            <span className="bg-[var(--lp-paper)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em]">
              {KIND_LABEL[entry.kind]}
            </span>
            {entry.isCurrent && (
              <span className="bg-[var(--lp-mint-soft)] px-2.5 py-0.5 text-[11px] font-bold">
                This device
              </span>
            )}
            <StatusPill status={entry.status} />
          </p>
          <p className="mt-1! break-all font-[family-name:var(--lp-mono)] text-xs">
            {entry.key.kind === "Secp256r1"
              ? `credential ${shorten(entry.key.value)}`
              : entry.key.value}
          </p>
          <p className="mt-1! text-xs text-[var(--lp-ink-faint)]">{KIND_BLURB[entry.kind]}</p>
          <p className="mt-1! text-xs text-[var(--lp-ink-faint)]">
            {entry.storage === "persistent" ? "Durable" : "Temporary"}
            {entry.expiresAt
              ? ` · expires ${new Date(entry.expiresAt).toLocaleString()}`
              : " · no expiry"}
            {entry.limits === undefined
              ? " · unrestricted"
              : ` · limited to ${entry.limits.length} contract${entry.limits.length === 1 ? "" : "s"}`}
          </p>
          {entry.limits && entry.limits.length > 0 && (
            <ul className="mt-1 list-none p-0 text-[11px] text-[var(--lp-ink-faint)]">
              {entry.limits.map((l) => (
                <li key={l.contract} className="break-all font-[family-name:var(--lp-mono)]">
                  {shorten(l.contract)}
                  {l.requiredCoSigners === null
                    ? " — no policy required"
                    : ` — requires ${l.requiredCoSigners.map((c) => `${c.kind} ${shorten(c.value)}`).join(", ")}`}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!mine && (
          <LpActionButton
            variant="outline"
            size="sm"
            onClick={onRevoke}
            disabled={!verdict.allowed || state.step === "approving" || state.step === "confirming"}
            aria-label={`${actionLabel} ${KIND_LABEL[entry.kind]} ${shorten(entry.key.value)}`}
          >
            {actionLabel}
          </LpActionButton>
        )}
      </div>

      {!verdict.allowed && verdict.reason !== "not-live" && (
        <p className="text-xs text-[var(--lp-ink-soft)]" data-testid="lockout-guard">
          {verdict.reason === "last-passkey"
            ? "This is the only passkey on the account. Revoking it would lock you out permanently — there is no seed phrase and no social recovery. Add a second passkey first."
            : "This is the last durable admin signer. The account contract refuses to remove it (it would make the account unrecoverable). Add another durable passkey first."}
        </p>
      )}

      {mine && state.step === "confirm" && (
        <div className="flex flex-col gap-2.5 border-t border-[var(--lp-line)] pt-2.5 text-xs">
          <p className="m-0! text-[var(--lp-ink)]">{confirmCopy(entry)}</p>
          <p className="m-0! text-[var(--lp-ink-faint)]">
            Network: <strong className="uppercase">{network}</strong>. Your passkey will be asked to
            approve the on-chain removal.
          </p>
          <div className="flex gap-2.5">
            <LpActionButton size="sm" onClick={onConfirm}>
              {entry.kind === "policy"
                ? "Approve detach with passkey"
                : `Approve revoke with passkey`}
            </LpActionButton>
            <LpActionButton variant="outline" size="sm" onClick={onCancel}>
              Keep it
            </LpActionButton>
          </div>
        </div>
      )}

      {mine && busy && (
        <p className="m-0! animate-pulse text-xs text-[var(--lp-ink-soft)]">
          {state.step === "approving"
            ? "Approve in your passkey…"
            : `Confirming on the network… ${state.hash}`}
        </p>
      )}

      {mine && state.step === "done" && (
        <p className="lpa-ok m-0! break-all text-xs">✓ Removed on-chain · tx {state.hash}</p>
      )}

      {mine && state.step === "error" && (
        <div className="flex items-center gap-3">
          <p role="alert" className="lpa-bad m-0! text-xs">
            {state.message}
          </p>
          <LpActionButton variant="outline" size="sm" onClick={onCancel}>
            Dismiss
          </LpActionButton>
        </div>
      )}
    </li>
  );
}

function confirmCopy(entry: SignerEntry): string {
  switch (entry.kind) {
    case "passkey":
      return "Revoke this passkey? It will no longer be able to sign for this account. If it is on a device you still use, you will need another passkey to sign in there.";
    case "device-session":
      return "Revoke this device session? The paired extension stops being able to approve transactions immediately (its 7-day session ends now).";
    case "agent":
      return "Revoke this agent key? This is the remote kill switch: the key stops signing immediately, including any payment a facilitator is still verifying.";
    case "policy":
      return "Detach this policy? Its rules stop applying to this account. This is the recovery path if a policy is blocking transactions you need — your passkey removes it directly, no policy approval required.";
    case "unknown":
      return "Revoke this signer? Its key type isn't recognized by this version of the app, so its exact effect on the account can't be confirmed here. The chain is still the authority on what this removes.";
  }
}

function StatusPill({ status }: { status: SignerEntry["status"] }) {
  const label =
    status === "live"
      ? "Active"
      : status === "expired"
        ? "Expired"
        : status === "evicted"
          ? "Evicted (temporary entry lapsed)"
          : "Removed";
  return (
    <span
      className={`text-[11px] font-bold ${status === "live" ? "lpa-ok" : "text-[var(--lp-ink-faint)]"}`}
    >
      {label}
    </span>
  );
}

function shorten(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}
