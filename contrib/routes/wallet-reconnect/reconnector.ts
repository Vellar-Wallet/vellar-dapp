/**
 * Wallet reconnection handler
 * Matches key IDs to wallet IDs from the sample registry
 */

import type { ReconnectResult } from "./types";
import { walletLookupMap } from "./sample-registry";

/**
 * Attempts to reconnect to a wallet using a stored key identifier
 * Returns the matching walletId or a 404-style error
 *
 * @param keyId The stored key identifier
 * @returns ReconnectResult with walletId on success or NOT_FOUND error
 */
export function reconnectWallet(keyId: string): ReconnectResult {
  // Validate input
  if (!keyId || keyId.trim() === "") {
    return {
      success: false,
      error: "NOT_FOUND",
      message: "Invalid key ID provided",
    };
  }

  // Look up the wallet ID
  const walletId = walletLookupMap.get(keyId);

  if (!walletId) {
    return {
      success: false,
      error: "NOT_FOUND",
      message: "Key not found in wallet registry",
    };
  }

  return {
    success: true,
    walletId,
    keyId,
  };
}

/**
 * Retrieves all registered key IDs
 * Useful for testing and debugging
 *
 * @returns Array of all known key IDs
 */
export function getAllRegisteredKeys(): string[] {
  return Array.from(walletLookupMap.keys());
}

/**
 * Checks if a key ID is registered
 *
 * @param keyId The key ID to check
 * @returns true if the key is registered, false otherwise
 */
export function isKeyRegistered(keyId: string): boolean {
  return walletLookupMap.has(keyId);
}
