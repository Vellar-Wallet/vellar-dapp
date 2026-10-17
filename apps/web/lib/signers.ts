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

export type { SignerEntry, SignerKeyRef, SignerKind } from "./signer-model";
export { canRevokeSigner, isLastPasskey } from "./signer-model";

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

export const LAST_SIGNER_CONFIRMATION_PHRASE = "REVOKE LAST SIGNER" as const;

export const ROUTINE_REVOKE_PROMPT =
  "Revoke this signer? Other signers will remain active on the wallet." as const;

export const LAST_SIGNER_REVOKE_PROMPT =
  "Warning: This is the only remaining signer on this wallet. Revoking it will permanently lock the wallet unless explicitly confirmed." as const;

export class LastSignerConfirmationRequiredError extends Error {
  readonly code = "LAST_SIGNER_CONFIRMATION_REQUIRED" as const;
  readonly prompt = LAST_SIGNER_REVOKE_PROMPT;

  constructor(
    message = `Cannot revoke the only remaining signer without explicit confirmation ("${LAST_SIGNER_CONFIRMATION_PHRASE}")`,
  ) {
    super(message);
    this.name = "LastSignerConfirmationRequiredError";
  }
}

function matchesTarget(entry: SignerEntry, target: SignerEntry | SignerKeyRef): boolean {
  if ("id" in target) {
    return entry.id === target.id;
  }
  return entry.key.kind === target.kind && entry.key.value === target.value;
}

/**
 * Returns true when revoking `target` would remove the sole remaining live signer on the wallet (#595).
 */
export function isOnlyRemainingSigner(
  target: SignerEntry | SignerKeyRef,
  entries: readonly SignerEntry[],
): boolean {
  const live = entries.filter((e) => e.status === "live");
  if (live.length === 0) return false;
  const remaining = live.filter((e) => !matchesTarget(e, target));
  return remaining.length === 0;
}

export interface SignerRevokeConfirmationStep {
  requiresLastSignerConfirmation: boolean;
  prompt: string;
  confirmationPhrase?: typeof LAST_SIGNER_CONFIRMATION_PHRASE;
}

/**
 * Returns the confirmation step required before revoking `target` (#595).
 * Produces a distinct high-friction confirmation prompt and phrase when `target`
 * is the only remaining signer on the wallet, versus a routine prompt when 2+ signers exist.
 */
export function getSignerRevokeConfirmation(
  target: SignerEntry | SignerKeyRef,
  entries: readonly SignerEntry[],
): SignerRevokeConfirmationStep {
  if (isOnlyRemainingSigner(target, entries)) {
    return {
      requiresLastSignerConfirmation: true,
      prompt: LAST_SIGNER_REVOKE_PROMPT,
      confirmationPhrase: LAST_SIGNER_CONFIRMATION_PHRASE,
    };
  }
  return {
    requiresLastSignerConfirmation: false,
    prompt: ROUTINE_REVOKE_PROMPT,
  };
}

/**
 * Executes signer revocation after enforcing the last-signer confirmation gate (#595).
 */
export async function revokeSignerWithConfirmation(input: {
  key: SignerKeyRef;
  entries: readonly SignerEntry[];
  confirmLastSigner?: boolean | string;
  removeSigner?: (key: SignerKeyRef) => Promise<{ hash: string }>;
  keyId?: string;
}): Promise<{ hash: string }> {
  if (isOnlyRemainingSigner(input.key, input.entries)) {
    const confirmed =
      input.confirmLastSigner === true ||
      input.confirmLastSigner === LAST_SIGNER_CONFIRMATION_PHRASE;
    if (!confirmed) {
      throw new LastSignerConfirmationRequiredError();
    }
  }

  if (input.removeSigner) {
    return input.removeSigner(input.key);
  }

  const runtime = await getWalletRuntime();
  if (input.keyId) await runtime.resume(input.keyId);
  return runtime.removeSigner(input.key);
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
    mutationFn: async (
      input:
        | SignerKeyRef
        | {
            key: SignerKeyRef;
            entries: readonly SignerEntry[];
            confirmLastSigner?: boolean | string;
          },
    ) => {
      if ("entries" in input) {
        return revokeSignerWithConfirmation({
          key: input.key,
          entries: input.entries,
          confirmLastSigner: input.confirmLastSigner,
          keyId,
        });
      }
      const runtime = await getWalletRuntime();
      if (keyId) await runtime.resume(keyId);
      return runtime.removeSigner(input);
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
