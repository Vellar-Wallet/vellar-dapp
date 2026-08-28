/**
 * Type definitions for wallet reconnection
 */

export interface ReconnectSuccess {
  success: true;
  walletId: string;
  keyId: string;
}

export interface ReconnectError {
  success: false;
  error: "NOT_FOUND";
  message: string;
}

export type ReconnectResult = ReconnectSuccess | ReconnectError;

/**
 * Internal key-to-wallet mapping
 */
export interface KeyWalletMapping {
  keyId: string;
  walletId: string;
}
