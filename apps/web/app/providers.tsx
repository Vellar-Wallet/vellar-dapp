"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet-context";
import { ConnectedWalletProvider } from "@/lib/connected-wallet-context";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      {/* Connected (G-address) wallets for the marketplace surfaces and the
          passkey wallet for /app are independent and both always mounted —
          new-build-technical-doc.md §3.1. */}
      <ConnectedWalletProvider>
        <WalletProvider>{children}</WalletProvider>
      </ConnectedWalletProvider>
    </QueryClientProvider>
  );
}
