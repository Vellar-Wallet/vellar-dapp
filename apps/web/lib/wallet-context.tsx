"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { CreateWalletInput, Network, WalletSession } from "@vellar/types";
import {
  createMemoryStorageAdapter,
  createSessionStore,
  createWebStorageAdapter,
  type PaymentClient,
  type SessionStatus,
  type WalletConnector,
} from "vellar-sdk";
import { createRealConnector, getRealPaymentClient, getRealSwapClient } from "./connector-factory";
import { getSafeLocalStorage } from "./safe-storage";
import type { SwapClient } from "./swap/client";

interface WalletContextValue {
  store: ReturnType<typeof createSessionStore>;
  getConnector: () => Promise<WalletConnector>;
  getPayments: () => Promise<PaymentClient>;
  getSwaps: () => Promise<SwapClient>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({
  children,
  connector,
  payments,
  swaps,
}: {
  children: ReactNode;
  /** Test seam: inject a fake connector instead of the real PasskeyKit one. */
  connector?: WalletConnector;
  /** Test seam: inject a fake payment client. */
  payments?: PaymentClient;
  /** Test seam: inject a fake swap client. */
  swaps?: SwapClient;
}) {
  const [store] = useState(() => {
    // SSR renders with an inert adapter. In browsers, localStorage access can
    // throw (private mode / restricted storage), so fall back to memory.
    const storage = getSafeLocalStorage();
    return createSessionStore(storage ? createWebStorageAdapter(storage) : createMemoryStorageAdapter());
  });

  useEffect(() => {
    void store.getState().restore();
  }, [store]);

  const value = useMemo<WalletContextValue>(
    () => ({
      store,
      getConnector: connector ? () => Promise.resolve(connector) : createRealConnector,
      // The real path resumes the kit connection from the persisted session's
      // keyId first — after a reload the kit starts disconnected and signer
      // operations would otherwise throw.
      getPayments: payments
        ? () => Promise.resolve(payments)
        : () => getRealPaymentClient(store.getState().session?.keyId),
      getSwaps: swaps
        ? () => Promise.resolve(swaps)
        : () => getRealSwapClient(store.getState().session?.keyId),
    }),
    [store, connector, payments, swaps],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("Wallet hooks must be used inside <WalletProvider>");
  return ctx;
}

export function useWalletSession(): WalletSession | null {
  return useStore(useWalletContext().store, (s) => s.session);
}

export function useWalletStatus(): SessionStatus {
  return useStore(useWalletContext().store, (s) => s.status);
}

export function usePaymentClient(): () => Promise<PaymentClient> {
  return useWalletContext().getPayments;
}

export function useSwapClient(): () => Promise<SwapClient> {
  return useWalletContext().getSwaps;
}

export interface WalletActions {
  createWallet(input: CreateWalletInput): Promise<WalletSession>;
  connectWallet(network: Network): Promise<WalletSession>;
  disconnect(): Promise<void>;
}

export function useWalletActions(): WalletActions {
  const ctx = useWalletContext();
  return useMemo(
    () => ({
      async createWallet(input) {
        const connector = await ctx.getConnector();
        const session = await connector.createWallet(input);
        await ctx.store.getState().start(session);
        return session;
      },
      async connectWallet(network) {
        const connector = await ctx.getConnector();
        const session = await connector.connectWallet(network);
        await ctx.store.getState().start(session);
        return session;
      },
      async disconnect() {
        await ctx.store.getState().end();
      },
    }),
    [ctx],
  );
}
