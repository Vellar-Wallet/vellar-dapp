import type { Network } from "@vellar/types";
import type { TokenInfo } from "vellar-sdk";

export type TokenAllowlistStatus = "allowlisted" | "unverified" | "revoked";

export interface RegistryToken extends TokenInfo {
  name: string;
  isNative?: boolean;
  /** True when the asset is in the active canonical allowlist for the network. */
  allowlisted?: boolean;
  /** Allowlist verification status used to visually flag unverified/revoked assets in the send flow (#561). */
  allowlistStatus?: TokenAllowlistStatus;
}

export interface TokenAllowlistAssessment {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  /** True only when currently present in the active allowlist and not revoked. */
  allowlisted: boolean;
  /** Distinguishes active allowlisted, arbitrary unverified custom, and formerly allowlisted (revoked) assets. */
  status: TokenAllowlistStatus;
  /** True when the send flow must visually flag this asset before the user signs. */
  flaggedForSendFlow: boolean;
  /** Short badge label for the send flow UI, or null when allowlisted. */
  badgeLabel: string | null;
  /** Detailed warning copy for the send flow UI, or null when allowlisted. */
  warningCopy: string | null;
}

export interface TokenAllowlistOptions {
  /** Override the active allowlist for the network. */
  allowlist?: ReadonlyArray<Pick<TokenInfo, "contractId" | "symbol"> & { name?: string }>;
  /** Optional snapshot of a prior allowlist to detect removed/revoked assets. */
  previousAllowlist?: ReadonlyArray<Pick<TokenInfo, "contractId" | "symbol">>;
  /** Explicit list of contract IDs that were removed/revoked from the allowlist. */
  revokedContractIds?: ReadonlyArray<string>;
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
      allowlisted: true,
      allowlistStatus: "allowlisted",
    },
    {
      contractId: MAINNET_USDC_SAC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 7,
      isNative: false,
      allowlisted: true,
      allowlistStatus: "allowlisted",
    },
  ],
  testnet: [
    {
      contractId: TESTNET_NATIVE_SAC,
      symbol: "XLM",
      name: "Stellar Lumens",
      decimals: 7,
      isNative: true,
      allowlisted: true,
      allowlistStatus: "allowlisted",
    },
    {
      contractId: TESTNET_USDC_SAC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 7,
      isNative: false,
      allowlisted: true,
      allowlistStatus: "allowlisted",
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
 * Assess whether a token is on the verified allowlist for `network`, an arbitrary
 * unverified custom asset, or a previously allowlisted asset that has been removed/revoked (#561).
 */
export function assessTokenAllowlist(
  network: Network,
  token: TokenInfo & {
    name?: string;
    allowlisted?: boolean;
    allowlistStatus?: TokenAllowlistStatus;
  },
  options?: TokenAllowlistOptions,
): TokenAllowlistAssessment {
  const normalizedContract = token.contractId.trim().toLowerCase();
  const activeList = options?.allowlist ?? getSupportedTokens(network);
  const revokedIds = new Set(
    (options?.revokedContractIds ?? []).map((id) => id.trim().toLowerCase()),
  );
  const previousIds = new Set(
    (options?.previousAllowlist ?? []).map((t) => t.contractId.trim().toLowerCase()),
  );

  // If a custom active allowlist was supplied, any default registry token omitted from it
  // (or any token carrying a prior allowlisted marker) is treated as removed/revoked.
  if (options?.allowlist) {
    for (const defaultToken of getSupportedTokens(network)) {
      previousIds.add(defaultToken.contractId.trim().toLowerCase());
    }
  }
  if (token.allowlisted === true || token.allowlistStatus === "allowlisted") {
    previousIds.add(normalizedContract);
  }

  const activeMatch = activeList.find(
    (entry) => entry.contractId.trim().toLowerCase() === normalizedContract,
  );
  const isRevoked =
    revokedIds.has(normalizedContract) ||
    token.allowlistStatus === "revoked" ||
    (!activeMatch && previousIds.has(normalizedContract));

  if (activeMatch && !revokedIds.has(normalizedContract) && token.allowlistStatus !== "revoked") {
    return {
      contractId: token.contractId,
      symbol: token.symbol,
      name: token.name ?? activeMatch.name ?? token.symbol,
      decimals: token.decimals,
      allowlisted: true,
      status: "allowlisted",
      flaggedForSendFlow: false,
      badgeLabel: null,
      warningCopy: null,
    };
  }

  if (isRevoked) {
    return {
      contractId: token.contractId,
      symbol: token.symbol,
      name: token.name ?? token.symbol,
      decimals: token.decimals,
      allowlisted: false,
      status: "revoked",
      flaggedForSendFlow: true,
      badgeLabel: "Removed from allowlist",
      warningCopy:
        "This asset was previously allowlisted but has been removed from the verified token allowlist. Verify the contract address before sending.",
    };
  }

  return {
    contractId: token.contractId,
    symbol: token.symbol,
    name: token.name ?? token.symbol,
    decimals: token.decimals,
    allowlisted: false,
    status: "unverified",
    flaggedForSendFlow: true,
    badgeLabel: "Unverified custom asset",
    warningCopy:
      "This custom asset is not on the verified token allowlist. Anyone can issue a token with the same symbol — verify the contract address before sending.",
  };
}

/**
 * Convenience boolean check returning true only when the token is currently allowlisted
 * on `network` and has not been revoked.
 */
export function isTokenAllowlisted(
  network: Network,
  tokenOrContractId:
    string | (TokenInfo & { allowlisted?: boolean; allowlistStatus?: TokenAllowlistStatus }),
  options?: TokenAllowlistOptions,
): boolean {
  const token: TokenInfo =
    typeof tokenOrContractId === "string"
      ? { contractId: tokenOrContractId, symbol: "", decimals: 7 }
      : tokenOrContractId;
  return assessTokenAllowlist(network, token, options).allowlisted;
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
