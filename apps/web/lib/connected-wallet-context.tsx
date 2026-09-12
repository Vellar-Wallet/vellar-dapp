"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  connectedWalletErrorMessage,
  connectedWalletPassphrase,
  createConnectedWalletKit,
  type ConnectedWalletNetwork,
  type ConnectedWalletState,
} from "@vellar/provider-sdk/connected-wallet";
import { walletConfig } from "./config";

// Connected (classic G-address) wallet context for the marketplace surfaces —
// new-build-technical-doc.md §3.2. This deliberately shares NOTHING with the
// passkey wallet context (lib/wallet-context.tsx): the two run in parallel and
// the passkey app (/app, /dashboard, /policies) is untouched by this file.

type ConnectedWalletContextValue = ConnectedWalletState & {
  connect: (walletId?: string) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
};

const ConnectedWalletContext = createContext<ConnectedWalletContextValue | null>(null);

const DISCONNECTED: ConnectedWalletState = {
  address: null,
  walletId: null,
  isConnecting: false,
  isConnected: false,
  error: null,
};

export function ConnectedWalletProvider({
  children,
  network,
}: {
  children: React.ReactNode;
  /** Defaults to the same network the passkey path reads from config. */
  network?: ConnectedWalletNetwork;
}) {
  // One passphrase source of truth for both surfaces (follow-on note 1): the
  // passkey path resolves it in lib/config.ts, so the connected path reads the
  // same config rather than hardcoding a second value.
  const config = useMemo(() => walletConfig(), []);
  const resolvedNetwork: ConnectedWalletNetwork = network ?? config.network;
  // config.networkPassphrase is operator-overridable via env; fall back to the
  // network's canonical passphrase when it is unset.
  const networkPassphrase =
    config.networkPassphrase || connectedWalletPassphrase(resolvedNetwork);

  const [state, setState] = useState<ConnectedWalletState>(DISCONNECTED);

  // Guards a late restore from clobbering a connect/disconnect that raced it.
  const restoredRef = useRef(false);

  // Restore on mount (follow-on note 2). The kit persists activeAddress and
  // selectedModuleId to localStorage itself (its state/effects.ts
  // updateActiveSession effect) and re-hydrates those signals at import, so
  // there is no second storage layer to maintain here. But a hydrated address
  // only proves what this browser last saw — it does NOT prove the wallet is
  // still connected. fetchAddress() round-trips to the wallet to confirm;
  // getAddress() would merely echo the cached signal back.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const kit = await createConnectedWalletKit(resolvedNetwork);
        const { address } = await kit.fetchAddress();
        if (cancelled || restoredRef.current) return;
        restoredRef.current = true;
        setState({
          address,
          walletId: kit.selectedModule.productId,
          isConnecting: false,
          isConnected: true,
          error: null,
        });
      } catch {
        // No live session (nothing persisted, permission revoked, extension
        // removed, wrong network). Stay disconnected and surface no error —
        // the user never asked to connect on this page load.
        if (cancelled || restoredRef.current) return;
        restoredRef.current = true;
        try {
          const kit = await createConnectedWalletKit(resolvedNetwork);
          await kit.disconnect();
        } catch {
          // Clearing stale state is best-effort.
        }
        if (!cancelled) setState(DISCONNECTED);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedNetwork]);

  const connect = useCallback(
    async (walletId?: string) => {
      restoredRef.current = true;
      setState((s) => ({ ...s, isConnecting: true, error: null }));
      try {
        const kit = await createConnectedWalletKit(resolvedNetwork);
        let address: string;
        if (walletId) {
          kit.setWallet(walletId);
          ({ address } = await kit.fetchAddress());
        } else {
          // authModal both selects the module and resolves the address.
          ({ address } = await kit.authModal());
        }
        setState({
          address,
          walletId: kit.selectedModule.productId,
          isConnecting: false,
          isConnected: true,
          error: null,
        });
      } catch (err) {
        setState({
          ...DISCONNECTED,
          error: connectedWalletErrorMessage(err, "Failed to connect wallet"),
        });
      }
    },
    [resolvedNetwork],
  );

  const disconnect = useCallback(() => {
    restoredRef.current = true;
    setState(DISCONNECTED);
    // Clears the kit's in-memory signals AND its persisted localStorage keys.
    void (async () => {
      try {
        const kit = await createConnectedWalletKit(resolvedNetwork);
        await kit.disconnect();
      } catch {
        // Local state is already cleared; nothing further to do.
      }
    })();
  }, [resolvedNetwork]);

  const signTransaction = useCallback(
    async (xdr: string) => {
      const kit = await createConnectedWalletKit(resolvedNetwork);
      // Always explicit (follow-on note 1): the kit would otherwise fall back
      // to its own selected-network signal, which can drift from the app's
      // configured network and silently sign for the wrong one.
      const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase });
      return signedTxXdr;
    },
    [resolvedNetwork, networkPassphrase],
  );

  const value = useMemo<ConnectedWalletContextValue>(
    () => ({ ...state, connect, disconnect, signTransaction }),
    [state, connect, disconnect, signTransaction],
  );

  return (
    <ConnectedWalletContext.Provider value={value}>{children}</ConnectedWalletContext.Provider>
  );
}

export function useConnectedWallet(): ConnectedWalletContextValue {
  const ctx = useContext(ConnectedWalletContext);
  if (!ctx) {
    throw new Error("useConnectedWallet must be used within ConnectedWalletProvider");
  }
  return ctx;
}
