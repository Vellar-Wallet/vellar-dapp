"use client";

import { useEffect, useState } from "react";
import type { WalletSession } from "@vellar/types";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import {
  checkPairingStatus,
  getInjectedProvider,
  pairExtension,
  recallPairing,
} from "@/lib/extension-pairing";
import { walletErrorMessage } from "@/lib/messages";
import { useRevokeSession, useSessions } from "@/lib/sessions";
import { useWalletActions, useWalletSession } from "@/lib/wallet-context";
import { getWalletRuntime } from "@/lib/connector-factory";
import type { AgentKeyRecord } from "@/lib/agent-keys";

// Account settings ("paper & signals" shell): session/device management +
// extension pairing.

export default function Settings() {
  const session = useWalletSession();
  const actions = useWalletActions();

  // The caller's own session id is the M1 bearer capability for the list/revoke
  // routes (RA-3) — thread it through so the device list loads and revokes apply.
  const sessions = useSessions(
    session?.accountId,
    session?.network ?? "testnet",
    session?.serverSessionId,
  );
  const revoke = useRevokeSession(
    session?.accountId,
    session?.network ?? "testnet",
    session?.serverSessionId,
  );

  async function revokeSession(id: string) {
    await revoke.mutateAsync(id);
    if (id === session?.serverSessionId) {
      await actions.disconnect();
    }
  }

  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <h1>Settings</h1>

        {session && <ExtensionPairingCard session={session} />}

        {session && <AgentKeysCard session={session} />}

        <section className="lpa-panel">
          <Eyebrow>Devices &amp; sessions</Eyebrow>
          <p className="mt-2! text-xs text-[var(--lp-ink-faint)]">
            Sessions opened for this account. Revoking this device signs you out.
          </p>

          {sessions.isPending && (
            <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">
              Loading sessions…
            </p>
          )}

          {sessions.isError && (
            <div className="mt-3.5 flex items-center gap-3">
              <p role="alert" className="lpa-bad text-sm">
                Couldn&apos;t load sessions.
              </p>
              <LpActionButton variant="outline" size="sm" onClick={() => void sessions.refetch()}>
                Retry
              </LpActionButton>
            </div>
          )}

          {sessions.data && (
            <ul className="mt-3.5 flex list-none flex-col gap-2.5 p-0">
              {sessions.data.length === 0 && (
                <li className="text-sm text-[var(--lp-ink-faint)]">No active sessions recorded.</li>
              )}
              {sessions.data.map((record) => {
                const isCurrent = record.id === session?.serverSessionId;
                return (
                  <li key={record.id} className="lpa-well flex items-center justify-between gap-4">
                    <div className="text-sm">
                      <p className="text-[var(--lp-ink-soft)]">
                        Session started {new Date(record.createdAt).toLocaleString()}
                        {isCurrent && (
                          <span className="ml-2 bg-[var(--lp-mint-soft)] px-2.5 py-0.5 text-[11px] font-bold">
                            This device
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--lp-ink-faint)]">
                        Last active {new Date(record.lastActiveAt).toLocaleString()}
                      </p>
                    </div>
                    <LpActionButton
                      variant="outline"
                      size="sm"
                      onClick={() => void revokeSession(record.id)}
                      disabled={revoke.isPending}
                    >
                      {isCurrent ? "Revoke & sign out" : "Revoke"}
                    </LpActionButton>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

type AgentKeyUiState =
  | { step: "loading" }
  | { step: "ready"; keys: AgentKeyRecord[]; message?: string }
  | { step: "error"; message: string };

function AgentKeysCard({ session }: { session: WalletSession }) {
  const [state, setState] = useState<AgentKeyUiState>({ step: "loading" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function load(message?: string) {
    setState({ step: "loading" });
    try {
      const runtime = await getWalletRuntime();
      if (session.keyId) await runtime.resume(session.keyId);
      const keys = await runtime.listAgentKeys(session.accountId);
      setState({ step: "ready", keys, ...(message ? { message } : {}) });
    } catch (err) {
      setState({ step: "error", message: walletErrorMessage(err) });
    }
  }

  useEffect(() => {
    void load();
    // Reload when the connected wallet changes; load deliberately remains local
    // so a retry uses the latest session without memoization boilerplate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accountId, session.keyId]);

  async function revoke(key: AgentKeyRecord) {
    setRevoking(key.publicKey);
    try {
      const runtime = await getWalletRuntime();
      if (session.keyId) await runtime.resume(session.keyId);
      const result = await runtime.revokeAgentKey(key.publicKey, key.policyContractIds);
      setConfirming(null);
      await load(
        result.alreadyRevoked
          ? "This key was already revoked on-chain."
          : "Agent key and its attached policies were revoked on-chain.",
      );
    } catch (err) {
      setState({ step: "error", message: walletErrorMessage(err) });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="lpa-panel">
      <Eyebrow>Agent keys</Eyebrow>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Live smart-wallet signers. Revocation is written on-chain and requires your passkey; it
        works as a remote kill switch even if the agent is active elsewhere.
      </p>

      {state.step === "loading" && (
        <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">
          Reading agent keys from chain…
        </p>
      )}

      {state.step === "error" && (
        <div className="mt-3.5 flex items-center gap-3">
          <p role="alert" className="lpa-bad text-sm">{state.message}</p>
          <LpActionButton variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </LpActionButton>
        </div>
      )}

      {state.step === "ready" && (
        <>
          {state.message && <p role="status" className="lpa-ok mt-3.5! text-sm">{state.message}</p>}
          <ul className="mt-3.5 flex list-none flex-col gap-2.5 p-0">
            {state.keys.length === 0 && (
              <li className="text-sm text-[var(--lp-ink-faint)]">No agent keys found on-chain.</li>
            )}
            {state.keys.map((key) => {
              const isConfirming = confirming === key.publicKey;
              return (
                <li key={key.publicKey} className="lpa-well flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 text-sm">
                      <p className="font-bold text-[var(--lp-ink-soft)]">{key.label}</p>
                      <p className="break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
                        {key.publicKey}
                      </p>
                    </div>
                    <span className={key.status === "active" ? "lpa-ok text-xs font-bold" : "lpa-bad text-xs font-bold"}>
                      {key.status === "active" ? "Active" : key.status === "expired" ? "Expired" : "Revoked"}
                    </span>
                  </div>
                  <dl className="grid gap-1 text-xs text-[var(--lp-ink-faint)]">
                    <div><dt className="inline font-bold">Expires: </dt><dd className="inline">{key.expiration ? new Date(key.expiration * 1000).toLocaleString() : "No expiry"}</dd></div>
                    <div><dt className="inline font-bold">Bound contracts: </dt><dd className="inline">{key.boundContracts.length ? key.boundContracts.join(", ") : "Unrestricted"}</dd></div>
                    <div><dt className="inline font-bold">Budget / window / spent: </dt><dd className="inline">Not exposed by this signer entry</dd></div>
                  </dl>
                  {key.status !== "revoked" && !isConfirming && (
                    <LpActionButton variant="outline" size="sm" onClick={() => setConfirming(key.publicKey)}>
                      Revoke on-chain
                    </LpActionButton>
                  )}
                  {isConfirming && (
                    <div className="flex flex-col gap-2 border-l-2 border-[var(--lp-red)] pl-3 text-xs">
                      <p>This immediately disables the agent and detaches its required policies.</p>
                      <div className="flex gap-2">
                        <LpActionButton size="sm" onClick={() => void revoke(key)} disabled={revoking !== null}>
                          {revoking === key.publicKey ? "Waiting for passkey…" : "Confirm with passkey"}
                        </LpActionButton>
                        <LpActionButton variant="outline" size="sm" onClick={() => setConfirming(null)} disabled={revoking !== null}>
                          Cancel
                        </LpActionButton>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

type PairingState =
  | { step: "idle" }
  | { step: "pairing" }
  | { step: "paired"; hash: string; expiresAt: string }
  | { step: "error"; message: string };

function ExtensionPairingCard({ session }: { session: WalletSession }) {
  const [detected, setDetected] = useState<boolean | null>(null);
  const [state, setState] = useState<PairingState>({ step: "idle" });

  useEffect(() => {
    const provider = getInjectedProvider();
    setDetected(provider !== undefined);
    if (!provider) return;
    void checkPairingStatus(session).then((paired) => {
      if (!paired) return;
      const remembered = recallPairing(session.accountId);
      setState((current) =>
        current.step === "idle"
          ? { step: "paired", hash: remembered?.hash ?? "", expiresAt: remembered?.expiresAt ?? "" }
          : current,
      );
    });
  }, [session]);

  async function pair() {
    setState({ step: "pairing" });
    try {
      const result = await pairExtension(session);
      setState({ step: "paired", hash: result.hash, expiresAt: result.expiresAt });
    } catch (err) {
      setState({ step: "error", message: walletErrorMessage(err) });
    }
  }

  return (
    <section className="lpa-panel">
      <Eyebrow>Browser extension</Eyebrow>
      <p className="mt-2! text-xs leading-relaxed text-[var(--lp-ink-faint)]">
        Pair the Vellar extension as a device signer: it can approve dApp transactions for 7 days,
        then expires automatically. You approve the pairing in the extension, then confirm with your
        passkey.
      </p>

      {detected === false && (
        <p className="mt-3.5! text-sm text-[var(--lp-ink-faint)]">
          Extension not detected in this browser. Install it, then reload this page.
        </p>
      )}

      {detected &&
        (state.step === "idle" || state.step === "error" || state.step === "pairing") && (
          <LpActionButton
            className="mt-3.5"
            onClick={() => void pair()}
            disabled={state.step === "pairing"}
          >
            {state.step === "pairing" ? "Pairing…" : "Pair extension"}
          </LpActionButton>
        )}

      {state.step === "paired" && (
        <div className="mt-3.5 flex flex-col items-start gap-2.5 text-sm">
          <span className="lpa-ok font-bold">
            ✓ Extension paired
            {state.expiresAt
              ? ` — active until ${new Date(state.expiresAt).toLocaleString()}`
              : " to this wallet"}
          </span>
          {state.hash && (
            <p className="break-all font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
              {state.hash}
            </p>
          )}
          <LpActionButton variant="outline" size="sm" onClick={() => void pair()}>
            Re-pair (new 7-day session)
          </LpActionButton>
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
