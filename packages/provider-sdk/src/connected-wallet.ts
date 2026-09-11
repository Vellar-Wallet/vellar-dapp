// Connected (classic G-address) wallet support for the marketplace surfaces,
// via Stellar Wallets Kit — new-build-technical-doc.md §3.1/§3.2.
//
// This is deliberately NOT re-exported from the package barrel (index.ts):
// apps/extension consumes @vellar/provider-sdk and must not inherit the kit's
// dependency tree. Import it through the "./connected-wallet" subpath export.
//
// API NOTE: @creit.tech/stellar-wallets-kit v2.x exposes StellarWalletsKit as
// an ALL-STATIC class over a module-global singleton — there is no constructor
// and no per-instance state. The spec (new-build-technical-doc.md §3.2) was
// written against an assumed `new StellarWalletsKit({...})` instance API that
// does not exist in the shipping package. We keep the spec's exported names
// and shapes and implement them against the real static API (docs/decisions.md).

import {
  StellarWalletsKit,
  Networks,
  type ISupportedWallet,
} from "@creit.tech/stellar-wallets-kit";

export type ConnectedWalletNetwork = "testnet" | "mainnet";

export type ConnectedWalletState = {
  address: string | null;
  walletId: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  error: string | null;
};

export type ConnectedWalletActions = {
  connect: (walletId?: string) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  getAddress: () => Promise<string>;
};

/** Network passphrase for a Vellar network name. Mirrors the values
 * apps/web/lib/config.ts resolves for the passkey path. */
export function connectedWalletPassphrase(network: ConnectedWalletNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

// The kit's state is a module-global singleton, so init() must run exactly
// once per page. Re-running it would reset activeModules and drop the
// modules array on every provider remount.
let initializedNetwork: ConnectedWalletNetwork | null = null;

/**
 * Idempotently initializes the global kit with the four wallet modules named
 * in new-build-technical-doc.md §3.1 and returns it.
 *
 * The modules are imported lazily because several of them reach for browser
 * globals (and their upstream CJS deps break under raw Node ESM), so this must
 * only ever be awaited in the browser — never during SSR.
 */
export async function createConnectedWalletKit(
  network: ConnectedWalletNetwork,
): Promise<typeof StellarWalletsKit> {
  if (initializedNetwork === network) return StellarWalletsKit;

  const kitNetwork = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  if (initializedNetwork !== null) {
    // Already initialized for a different network: swap the network only,
    // keeping the registered modules intact.
    StellarWalletsKit.setNetwork(kitNetwork);
    initializedNetwork = network;
    return StellarWalletsKit;
  }

  const [{ FreighterModule }, { AlbedoModule }, { xBullModule }, { LobstrModule }] =
    await Promise.all([
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
    ]);

  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new AlbedoModule(),
      new xBullModule(),
      new LobstrModule(),
    ],
    network: kitNetwork,
  });

  initializedNetwork = network;
  return StellarWalletsKit;
}

/**
 * The kit rejects with a plain `{ code, message }` object rather than an
 * `Error` (see its sdk/utils.ts parseError), so `err instanceof Error` alone
 * silently loses the message.
 */
export function connectedWalletErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const { message } = err as { message?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

export type { ISupportedWallet };
export { StellarWalletsKit, Networks };
