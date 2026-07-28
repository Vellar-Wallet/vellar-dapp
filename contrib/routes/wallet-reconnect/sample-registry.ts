/**
 * Sample key-to-wallet registry
 * In production, this would be stored in a database
 */

import type { KeyWalletMapping } from "./types";

/**
 * Predefined mappings of key IDs to wallet IDs
 */
export const walletRegistry: KeyWalletMapping[] = [
  {
    keyId: "key_user_001",
    walletId: "wallet_alice_primary",
  },
  {
    keyId: "key_user_002",
    walletId: "wallet_bob_primary",
  },
  {
    keyId: "key_user_003",
    walletId: "wallet_carol_primary",
  },
];

/**
 * Creates a lookup map for O(1) access
 */
export const walletLookupMap = new Map<string, string>(
  walletRegistry.map((entry) => [entry.keyId, entry.walletId]),
);

/**
 * Known key IDs for testing
 */
export const knownKeyIds = walletRegistry.map((entry) => entry.keyId);

/**
 * Sample unknown key ID for testing error cases
 */
export const unknownKeyId = "key_unknown_999";
