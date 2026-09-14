import { formatTokenAmount } from "vellar-sdk";

// Wire contract for marketplace-service's public listing shape
// (services/marketplace-service/src/routes/listings.ts toPublicListing()).
// Hand-mirrored rather than imported from the service package: the web app
// and marketplace-service are separately deployable, so this is the API
// contract, not an internal implementation detail to share code with.
export type ListingStatus = "pending" | "active" | "paused" | "removed";
export type ListingScheme = "exact" | "upto";

export interface ListingRecord {
  id: string;
  sellerAddress: string;
  resourceUrl: string;
  title: string;
  description: string | null;
  /** Base units, stringly-typed at the boundary (same reasoning as the
   * service's ListingRecord: a 7-decimal asset's amount must never round-trip
   * through a lossy JS number). */
  priceAtomic: string;
  asset: string;
  scheme: ListingScheme;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
  firstSettledAt: string | null;
  totalSettlements: string;
  totalRevenue: string;
}

// All marketplace listings are priced in the USDC Soroban SAC, which — like
// every Stellar SAC — always uses 7 decimals (stroop-equivalent precision).
const USDC_DECIMALS = 7;

/** Format a base-units price/revenue string for display (listings are USDC-only today). */
export function formatPriceAtomic(atomic: string): string {
  return formatTokenAmount(BigInt(atomic), USDC_DECIMALS);
}
