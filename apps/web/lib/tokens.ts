import type { Network } from "@vellar/types";
import type { TokenInfo } from "vellar-sdk";

export interface RegistryToken extends TokenInfo {
  name: string;
  isNative?: boolean;
  /** On the curated TOKEN_REGISTRY right now. Arbitrary/custom assets are not. */
  isAllowlisted: boolean;
  /** Has a verification record (attestation provenance). Curated entries do. */
  isVerified: boolean;
}

/**
 * Send-flow trust signal for an asset. Derived from the CURRENT registry only —
 * never cached — so an asset that was allowlisted and has since been removed
 * immediately reads as untrusted.
 */
export interface TokenTrust {
  allowlisted: boolean;
  verified: boolean;
  /** The send-flow UI should visually flag this asset as untrusted. */
  shouldFlag: boolean;
}

/**
 * Mainnet USDC Stellar Asset Contract (SAC) ID.
 * Captured in services/lifecycle-service/src/server.ts and matching @x402/stellar DEFAULT_ASSETS for stellar:pubnet.
 */
export const MAINNET_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/**
 * Testnet USDC Stellar Asset Contract (SAC) ID.
 */
export const TESTNET_USDC_SAC = "CBIELTK6YBZJU5UP2QPQEHGTTDAKAEVWTODQO6QD3J6XEUOFQMS5TRHT";

/**
 * Standard native SAC contract IDs on Stellar networks.
 */
export const TESTNET_NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const MAINNET_NATIVE_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

export const TOKEN_REGISTRY: Record<Network, RegistryToken[]> = {
  mainnet: [
    {
      contractId: MAINNET_NATIVE_SAC,
      symbol: "XLM",
      name: "Stellar Lumens",
      decimals: 7,
      isNative: true,
      isAllowlisted: true,
      isVerified: true,
    },
    {
      contractId: MAINNET_USDC_SAC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 7,
      isNative: false,
      isAllowlisted: true,
      isVerified: true,
    },
  ],
  testnet: [
    {
      contractId: TESTNET_NATIVE_SAC,
      symbol: "XLM",
      name: "Stellar Lumens",
      decimals: 7,
      isNative: true,
      isAllowlisted: true,
      isVerified: true,
    },
    {
      contractId: TESTNET_USDC_SAC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 7,
      isNative: false,
      isAllowlisted: true,
      isVerified: true,
    },
  ],
};

/**
 * Return the canonical list of supported tokens for a given network.
 */
export function getSupportedTokens(network: Network): RegistryToken[] {
  return TOKEN_REGISTRY[network] ?? TOKEN_REGISTRY.testnet;
}

/**
 * Find a token in the registry by contract address or symbol.
 */
export function findToken(network: Network, identifier: string): RegistryToken | undefined {
  const tokens = getSupportedTokens(network);
  const normalized = identifier.trim().toLowerCase();
  return tokens.find(
    (t) => t.contractId.toLowerCase() === normalized || t.symbol.toLowerCase() === normalized,
  );
}

/**
 * Trust signal for the send flow. Registry membership is evaluated live, so an
 * asset that was previously allowlisted and has since been removed is flagged
 * again the moment it leaves TOKEN_REGISTRY.
 */
export function getTokenTrust(network: Network, identifier: string): TokenTrust {
  const token = findToken(network, identifier);
  if (!token) return { allowlisted: false, verified: false, shouldFlag: true };
  return {
    allowlisted: token.isAllowlisted,
    verified: token.isVerified,
    shouldFlag: !token.isAllowlisted,
  };
}

/**
 * Format a raw integer token amount given arbitrary decimal precision.
 * Works for 7 decimals (USDC/XLM), 6 decimals, 18 decimals, etc.
 */
export function formatAmountWithDecimals(
  rawAmount: bigint,
  decimals: number,
  maxFractionDigits: number = decimals,
): string {
  if (decimals < 0 || decimals > 36) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  if (rawAmount === 0n) return "0";

  const isNegative = rawAmount < 0n;
  const absAmount = isNegative ? -rawAmount : rawAmount;
  const base = 10n ** BigInt(decimals);

  const integerPart = absAmount / base;
  const fractionPart = absAmount % base;

  if (fractionPart === 0n) {
    return `${isNegative ? "-" : ""}${integerPart.toString()}`;
  }

  let fractionStr = fractionPart.toString().padStart(decimals, "0");
  // Trim trailing zeros
  fractionStr = fractionStr.replace(/0+$/, "");
  if (fractionStr.length > maxFractionDigits) {
    fractionStr = fractionStr.slice(0, maxFractionDigits);
  }

  return `${isNegative ? "-" : ""}${integerPart.toString()}.${fractionStr}`;
}

/**
 * Parse a decimal string into raw integer units for a specific token decimal precision.
 */
export function parseAmountWithDecimals(value: string, decimals: number): bigint {
  if (decimals < 0 || decimals > 36) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") {
    throw new Error("Invalid amount");
  }

  const [integerPart = "0", fractionPart = ""] = trimmed.split(".");
  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionPart)) {
    throw new Error(`"${trimmed}" is not a valid amount`);
  }

  if (fractionPart.length > decimals) {
    throw new Error(
      `Amount has ${fractionPart.length} decimal places, but token only supports ${decimals}`,
    );
  }

  const paddedFraction = fractionPart.padEnd(decimals, "0");
  const wholeUnits = BigInt(integerPart || "0") * 10n ** BigInt(decimals);
  const fracUnits = BigInt(paddedFraction);

  return wholeUnits + fracUnits;
}
