"use client";

import { useEffect, useState } from "react";
import type { WalletSession } from "@vela/types";
import { AppShell } from "@/components/app-shell";
import {
  checkPairingStatus,
  getInjectedProvider,
  pairExtension,
  recallPairing,
} from "@/lib/extension-pairing";
import { walletErrorMessage } from "@/lib/messages";
import { useRevokeSession, useSessions } from "@/lib/sessions";
import { useWalletActions, useWalletSession } from "@/lib/wallet-context";

// Account settings in the app shell (docs/decisions.md): session/device
// management + extension pairing on neomorphic surfaces.

export default function Settings() {
  const session = useWalletSession();
  const actions = useWalletActions();

  const sessions = useSessions(session?.accountId, session?.network ?? "testnet");
  const revoke = useRevokeSession(session?.accountId, session?.network ?? "testnet");

  async function revokeSession(id: string) {
    await revoke.mutateAsync(id);
    if (id === session?.serverSessionId) {
      await actions.disconnect();
    }
  }

  return (
    <AppShell>
      <div
        style={{
          maxWidth: 720,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <h1 style={{ fontSize: "clamp(1.8rem,4vw,2.4rem)" }}>Settings</h1>

        {session && <ExtensionPairingCard session={session} />}

        <section className="neo" style={{ padding: 22 }}>
          <span className="eyebrow">Devices &amp; sessions</span>
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)" }}>
            Sessions opened for this account. Revoking this device signs you out.
          </p>

          {sessions.isPending && (
            <p
              className="animate-pulse"
              style={{ marginTop: 14, fontSize: 14, color: "var(--muted2)" }}
            >
              Loading sessions…
            </p>
          )}

          {sessions.isError && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <p role="alert" style={{ fontSize: 14, color: "var(--negative)" }}>
                Couldn&apos;t load sessions.
              </p>
              <button onClick={() => void sessions.refetch()} className="btn btn-dark btn-sm">
                Retry
              </button>
            </div>
          )}

          {sessions.data && (
            <ul
              style={{
                listStyle: "none",
                margin: "14px 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {sessions.data.length === 0 && (
                <li style={{ fontSize: 14, color: "var(--muted2)" }}>
                  No active sessions recorded.
                </li>
              )}
              {sessions.data.map((record) => {
                const isCurrent = record.id === session?.serverSessionId;
                return (
                  <li
                    key={record.id}
                    className="neo-inset"
                    style={{
                      padding: "14px 16px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                    }}
                  >
                    <div style={{ fontSize: 14 }}>
                      <p style={{ color: "var(--muted)" }}>
                        Session started {new Date(record.createdAt).toLocaleString()}
                        {isCurrent && (
                          <span
                            className="active-state"
                            style={{
                              marginLeft: 8,
                              borderRadius: 999,
                              padding: "2px 10px",
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            This device
                          </span>
                        )}
                      </p>
                      <p style={{ fontSize: 12, color: "var(--muted2)" }}>
                        Last active {new Date(record.lastActiveAt).toLocaleString()}
                      </p>
                    </div>
                    <button
                      onClick={() => void revokeSession(record.id)}
                      disabled={revoke.isPending}
                      className="btn btn-dark btn-sm"
                    >
                      {isCurrent ? "Revoke & sign out" : "Revoke"}
                    </button>
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
    <section className="neo" style={{ padding: 22 }}>
      <span className="eyebrow">Browser extension</span>
      <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)", lineHeight: 1.6 }}>
        Pair the VELA extension as a device signer: it can approve dApp transactions for 7 days,
        then expires automatically. You approve the pairing in the extension, then confirm with your
        passkey.
      </p>

      {detected === false && (
        <p style={{ marginTop: 14, fontSize: 14, color: "var(--muted2)" }}>
          Extension not detected in this browser. Install it, then reload this page.
        </p>
      )}

      {detected &&
        (state.step === "idle" || state.step === "error" || state.step === "pairing") && (
          <button
            onClick={() => void pair()}
            disabled={state.step === "pairing"}
            className="btn btn-signal"
            style={{ marginTop: 14 }}
          >
            {state.step === "pairing" ? "Pairing…" : "Pair extension"}
          </button>
        )}

      {state.step === "paired" && (
        <div style={{ marginTop: 14, fontSize: 14 }}>
          <span className="verified" style={{ color: "var(--signal)" }}>
            ✓ Extension paired
            {state.expiresAt
              ? ` — active until ${new Date(state.expiresAt).toLocaleString()}`
              : " to this wallet"}
          </span>
          {state.hash && (
            <p
              className="mono"
              style={{ marginTop: 8, wordBreak: "break-all", fontSize: 12, color: "var(--muted2)" }}
            >
              {state.hash}
            </p>
          )}
          <button
            onClick={() => void pair()}
            className="btn btn-dark btn-sm"
            style={{ marginTop: 10 }}
          >
            Re-pair (new 7-day session)
          </button>
        </div>
      )}

      {state.step === "error" && (
        <p role="alert" style={{ marginTop: 10, fontSize: 14, color: "var(--negative)" }}>
          {state.message}
        </p>
      )}
    </section>
  );
}
