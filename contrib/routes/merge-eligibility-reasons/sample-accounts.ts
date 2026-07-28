/**
 * Sample accounts for testing merge eligibility
 */

import type { Account } from "./types";

/**
 * Sample Account 1: Eligible for merging
 * - No open trustlines
 * - No pending offers
 * - No escrow entries
 * - Clawback disabled
 */
export const eligibleAccount: Account = {
  id: "GAAA2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ",
  trustlines: [],
  offers: [],
  escrow: [],
  clawbackEnabled: false,
};

/**
 * Sample Account 2: Ineligible for merging
 * - 2 open trustlines
 * - 1 pending offer
 * - 1 escrow entry
 * - Clawback disabled (but other issues exist)
 */
export const ineligibleAccount: Account = {
  id: "GBBB2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ",
  trustlines: [
    {
      asset: "USD:GBUQWP3BOUZX34TOLXCI35FQ7KQJH3P25PMMOMQ5J2MABG3HQZPX5YHK",
      balance: "100.50",
    },
    {
      asset: "EUR:GDGU6VM5PSPZTHTFIUYJQMTHEGYLOQJQJQJQJQJQJQJQJQJQJQJQJQJQJQ",
      balance: "50.25",
    },
  ],
  offers: [
    {
      id: "offer-123",
      selling: "native",
      buying: "USD:GBUQWP3BOUZX34TOLXCI35FQ7KQJH3P25PMMOMQ5J2MABG3HQZPX5YHK",
    },
  ],
  escrow: [
    {
      id: "escrow-456",
      amount: "1000.00",
    },
  ],
  clawbackEnabled: false,
};
