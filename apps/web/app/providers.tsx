"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet-context";
import { getSafeLocalStorage } from "@/lib/safe-storage";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // Touch storage defensively during app-shell initialization. Some browsers
  // throw on localStorage access; probing here keeps initialization explicit
  // and ensures we only pass a usable storage object to consumers.
  getSafeLocalStorage();

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{children}</WalletProvider>
    </QueryClientProvider>
  );
}
