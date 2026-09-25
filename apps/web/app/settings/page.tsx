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
import { useAgentKeys, useRevokeAgentKey } from "@/lib/agent-keys";
import { AddPasskeyCard } from "./add-passkey-card";
import { AgentKeysCard } from "./agent-keys-card";
import { ProvenanceCard } from "./provenance-card";
import { SignersCard } from "./signers-card";
import { WalletUpgradeCard } from "./wallet-upgrade-card";

// Account settings ("paper & signals" shell): signer management (#401),
// agent keys (#394), verified-provenance signing (#398), wallet contract
// upgrade (open-work 5.1), extension pairing
// and server-side device sessions.

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

  const agentKeys = useAgentKeys(session?.accountId, session?.network);
  const revokeKey = useRevokeAgentKey(session?.accountId, session?.network);

  async function revokeSession(id: string) {
    await revoke.mutateAsync(id);
    if (id === session?.serverSessionId) {
      await actions.disconnect();
    }
  }

  async function revokeAgent(publicKey: string, policyContractId?: string) {
    await revokeKey.mutateAsync({ publicKey, policyContractId });
  }

  return (
    <AppShell>
      <div className="flex max-w-[720px] flex-col gap-5">
        <h1>Settings</h1>

        {session && <SignersCard session={session} />}
        {session && <AddPasskeyCard session={session} />}
        {session && <AgentKeysCard session={session} />}
        {session && <ProvenanceCard session={session} />}
        {session && <WalletUpgradeCard session={session} />}
        {session && <ExtensionPairingCard session={session} />}

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

        <section className="lpa-panel">
          <Eyebrow>Agent session keys</Eyebrow>
          <p className="mt-2! text-xs text-[var(--lp-ink-faint)]">
            Autonomous agent keys authorized to pay under on-chain budgets (§17.3). Revocation
            removes the key on-chain as a remote kill switch.
          </p>

          {agentKeys.isPending && (
            <p className="mt-3.5! animate-pulse text-sm text-[var(--lp-ink-faint)]">
              Loading agent keys…
            </p>
          )}

          {agentKeys.isError && (
            <div className="mt-3.5 flex items-center gap-3">
              <p role="alert" className="lpa-bad text-sm">
                Couldn&apos;t load agent keys.
              </p>
              <LpActionButton variant="outline" size="sm" onClick={() => void agentKeys.refetch()}>
                Retry
              </LpActionButton>
            </div>
          )}

          {agentKeys.data && (
            <ul className="mt-3.5 flex list-none flex-col gap-2.5 p-0">
              {agentKeys.data.length === 0 && (
                <li className="text-sm text-[var(--lp-ink-faint)]">
                  No agent keys authorized yet.
                </li>
              )}
              {agentKeys.data.map((key) => {
                const isActive = key.status === "active";
                const isExpired = key.status === "expired";

                return (
                  <li key={key.publicKey} className="lpa-well flex flex-col gap-2 p-3 text-sm">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <b className="text-[var(--lp-ink)]">{key.label ?? "Autonomous Agent"}</b>
                        <span className="ml-2 font-[family-name:var(--lp-mono)] text-xs text-[var(--lp-ink-faint)]">
                          {key.publicKey.slice(0, 6)}…{key.publicKey.slice(-6)}
                        </span>
                      </div>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase ${
                          isActive
                            ? "bg-[var(--lp-mint-soft)] text-[var(--lp-mint-dark)]"
                            : isExpired
                              ? "bg-amber-100 text-amber-800"
                              : "bg-red-100 text-red-700"
                        }`}
                      >
                        {key.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs text-[var(--lp-ink-soft)] sm:grid-cols-4">
                      <div>
                        <span className="block text-[var(--lp-ink-faint)]">Token:</span>
                        <span>{key.boundToken}</span>
                      </div>
                      <div>
                        <span className="block text-[var(--lp-ink-faint)]">Budget:</span>
                        <span>{key.budget}</span>
                      </div>
                      <div>
                        <span className="block text-[var(--lp-ink-faint)]">Window:</span>
                        <span>{key.window}</span>
                      </div>
                      <div>
                        <span className="block text-[var(--lp-ink-faint)]">Expires:</span>
                        <span>
                          {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never"}
                        </span>
                      </div>
                    </div>

                    {isActive && (
                      <div className="mt-1 flex justify-end">
                        <LpActionButton
                          variant="outline"
                          size="sm"
                          onClick={() => void revokeAgent(key.publicKey, key.policyContractId)}
                          disabled={revokeKey.isPending}
                        >
                          {revokeKey.isPending ? "Revoking…" : "Revoke (kill switch)"}
                        </LpActionButton>
                      </div>
                    )}
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
        passkey. Paired devices appear in the signer list above as device sessions.
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
