/**
 * Sample account IDs for testing cleanup plans
 */

/**
 * Sample Account 1: Simple cleanup
 * ID: GAAA2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ
 *
 * Plan:
 * - Close 1 trustline
 * - Cancel 1 offer
 * - Final verification
 * Total: 3 steps
 */
export const simpleAccountId = "GAAA2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ";

/**
 * Sample Account 2: Complex cleanup
 * ID: GBBB2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ
 *
 * Plan:
 * - Close 2 trustlines
 * - Cancel 2 offers
 * - Release 1 escrow entry
 * - Disable clawback
 * - Final verification
 * Total: 7 steps
 */
export const complexAccountId = "GBBB2B3GRZL6XWDPJ5L3HVPFQY6A3OKDKDKJQJQJQJQJQJQJQJQJQJQJQJQJQ";
