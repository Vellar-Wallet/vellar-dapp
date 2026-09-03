/**
 * Wallet creation handshake handler
 * Manages two-step registration and confirmation flow
 */

import type { RegisterResponse, ConfirmResult, WalletState } from "./types";

/**
 * In-memory storage for pending and created wallets
 * In production, this would be a database
 */
const walletStorage = new Map<string, WalletState>();

/**
 * Generates a unique wallet ID
 */
function generateWalletId(): string {
  return `wallet_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Generates a challenge string for verification
 */
function generateChallenge(): string {
  return `challenge_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

/**
 * Initiates wallet creation - Step 1 of handshake
 * Returns a pending wallet ID and challenge string
 *
 * @returns RegisterResponse with pending walletId and challenge
 */
export function registerWallet(): RegisterResponse {
  const walletId = generateWalletId();
  const challenge = generateChallenge();

  const walletState: WalletState = {
    walletId,
    challenge,
    status: "pending",
    createdAt: Date.now(),
  };

  walletStorage.set(walletId, walletState);

  return {
    walletId,
    challenge,
    status: "pending",
  };
}

/**
 * Confirms wallet creation - Step 2 of handshake
 * Accepts a pending wallet ID and marks it as created
 *
 * @param walletId The pending wallet ID from register step
 * @returns ConfirmResult with created status or error
 */
export function confirmWallet(walletId: string): ConfirmResult {
  const wallet = walletStorage.get(walletId);

  if (!wallet) {
    return {
      walletId,
      status: "error",
      message: "Wallet not found or already confirmed",
    };
  }

  if (wallet.status === "created") {
    return {
      walletId,
      status: "error",
      message: "Wallet already created",
    };
  }

  if (wallet.status === "expired") {
    return {
      walletId,
      status: "error",
      message: "Wallet registration expired",
    };
  }

  // Mark wallet as created
  wallet.status = "created";
  walletStorage.set(walletId, wallet);

  return {
    walletId,
    status: "created",
    message: "Wallet successfully created",
  };
}

/**
 * Retrieves the current state of a wallet
 * Useful for testing and debugging
 *
 * @param walletId The wallet ID to retrieve
 * @returns The wallet state or undefined if not found
 */
export function getWalletState(walletId: string): WalletState | undefined {
  return walletStorage.get(walletId);
}

/**
 * Clears all wallets from storage
 * Useful for resetting state between tests
 */
export function clearWalletStorage(): void {
  walletStorage.clear();
}
