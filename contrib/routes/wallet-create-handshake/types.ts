/**
 * Type definitions for wallet creation handshake
 */

export interface RegisterResponse {
  walletId: string;
  challenge: string;
  status: "pending";
}

export interface ConfirmResult {
  walletId: string;
  status: "created" | "error";
  message?: string;
}

/**
 * Internal wallet state for tracking pending and created wallets
 */
export interface WalletState {
  walletId: string;
  challenge: string;
  status: "pending" | "created" | "expired";
  createdAt: number;
}
