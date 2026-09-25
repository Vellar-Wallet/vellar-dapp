"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Network } from "@vellar/types";
import { getWalletRuntime } from "./connector-factory";

// Wallet contract version + upgrade hooks (open-work 5.1). The version is chain
// state (the wallet instance's wasm hash), read directly from the ledger — the
// same "no authoritative local copy" rule as lib/signers.ts. Isolated in its
// own module so component tests can mock it.

export type { WalletVersionStatus } from "./wallet-upgrade";

export const walletVersionKey = (accountId: string | undefined, network: Network) => [
  "wallet-version",
  accountId,
  network,
];

export function useWalletVersion(accountId: string | undefined, network: Network) {
  return useQuery({
    queryKey: walletVersionKey(accountId, network),
    enabled: accountId !== undefined,
    queryFn: async () => {
      const runtime = await getWalletRuntime();
      return runtime.walletVersion(accountId as string);
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Passkey-approved `upgrade(new_wasm_hash)`: the CURRENT passkey signs the
 * wallet's own upgrade call. Resolves once the transaction is submitted. */
export function useUpgradeWallet(
  accountId: string | undefined,
  network: Network,
  keyId: string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!accountId) throw new Error("No wallet is connected.");
      const runtime = await getWalletRuntime();
      if (keyId) await runtime.resume(keyId);
      return runtime.upgradeWallet(accountId);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: walletVersionKey(accountId, network) }),
  });
}
