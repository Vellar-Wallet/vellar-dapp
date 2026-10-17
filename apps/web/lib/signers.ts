"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Network } from "@vellar/types";
import { getWalletRuntime } from "./connector-factory";
import { classifySigners, type SignerEntry, type SignerKeyRef } from "./signer-model";

// Signer-management data hooks (#401): the account's signer set as the CHAIN
// reports it. The runtime's `listSigners` enumerates through passkey-kit's
// hosted signer indexer (an index of the wallet's own on-chain events) and
// confirms every live entry with a direct ledger read (`kit.getSigner`), so a
// signer added or revoked on another device shows up here on refresh — there
// is no authoritative local signer list. Isolated in this module so component
// tests can mock it, mirroring lib/sessions.ts.

export type { SignerCategory, SignerEntry, SignerKeyRef, SignerKind } from "./signer-model";
export {
  canRevokeSigner,
  classifySignerType,
  getSignerCategory,
  isDeviceSigner,
  isLastPasskey,
  isPasskeySigner,
  isPolicySigner,
} from "./signer-model";

export const signersKey = (accountId: string | undefined, network: Network) => [
  "signers",
  accountId,
  network,
];

export function useSigners(
  accountId: string | undefined,
  network: Network,
  keyId: string | undefined,
) {
  return useQuery({
    queryKey: signersKey(accountId, network),
    enabled: accountId !== undefined,
    queryFn: async (): Promise<SignerEntry[]> => {
      const runtime = await getWalletRuntime();
      if (keyId) await runtime.resume(keyId);
      const raw = await runtime.listSigners(accountId as string);
      return classifySigners(raw, { currentKeyId: keyId, walletAddress: accountId as string });
    },
    // Chain state, not a cache: never serve a stale list silently after a
    // mutation; refetch on window focus so a cross-device change is picked up.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Invalidate the signer list after any on-chain signer mutation. */
export function useInvalidateSigners(accountId: string | undefined, network: Network) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: signersKey(accountId, network) });
}

/** On-chain removal of any signer (passkey / device session / agent key /
 * policy). Passkey-approved: the kit prompts the CURRENT passkey to sign the
 * wallet's `remove_signer`. Resolves once the transaction is submitted. */
export function useRevokeSigner(
  accountId: string | undefined,
  network: Network,
  keyId: string | undefined,
) {
  const invalidate = useInvalidateSigners(accountId, network);
  return useMutation({
    mutationFn: async (key: SignerKeyRef) => {
      const runtime = await getWalletRuntime();
      if (keyId) await runtime.resume(keyId);
      return runtime.removeSigner(key);
    },
    onSettled: () => void invalidate(),
  });
}

/** Add a second passkey: browser registration ceremony for the NEW passkey,
 * then the EXISTING passkey approves the wallet's `add_signer`. Only after that
 * transaction is submitted does the new passkey exist on-chain. */
export function useAddPasskey(
  accountId: string | undefined,
  network: Network,
  keyId: string | undefined,
) {
  const invalidate = useInvalidateSigners(accountId, network);
  return useMutation({
    mutationFn: async (label: string) => {
      const runtime = await getWalletRuntime();
      if (keyId) await runtime.resume(keyId);
      return runtime.addPasskeySigner(label);
    },
    onSettled: () => void invalidate(),
  });
}
