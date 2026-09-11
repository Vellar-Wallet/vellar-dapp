"use client";

import { useConnectedWallet } from "../../lib/connected-wallet-context";

// UI entry point for connecting a classic Stellar wallet —
// new-build-technical-doc.md §3.2. Used in the marketplace, seller portal,
// and team dashboard headers.

export function WalletConnectButton() {
  const { isConnected, isConnecting, address, connect, disconnect, error } = useConnectedWallet();

  if (isConnecting) {
    return (
      <button
        disabled
        className="cursor-not-allowed rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-400"
      >
        Connecting...
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-sm text-neutral-300"
          title={address}
          data-testid="connected-wallet-address"
        >
          {address.slice(0, 4)}...{address.slice(-4)}
        </span>
        <button
          onClick={disconnect}
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-700"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => void connect()}
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-neutral-100"
      >
        Connect Wallet
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
