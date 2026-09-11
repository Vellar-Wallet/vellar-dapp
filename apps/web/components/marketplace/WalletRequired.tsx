"use client";

import { useConnectedWallet } from "../../lib/connected-wallet-context";
import { WalletConnectButton } from "./WalletConnectButton";

// Gate for any action that needs a connected wallet —
// new-build-technical-doc.md §3.4. Wraps PayButton, ListingForm, and
// TeamBudgetCard in later milestones.

export function WalletRequired({
  children,
  message = "Connect your wallet to continue",
}: {
  children: React.ReactNode;
  message?: string;
}) {
  const { isConnected } = useConnectedWallet();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <p className="text-sm text-neutral-400">{message}</p>
        <WalletConnectButton />
      </div>
    );
  }

  return <>{children}</>;
}
