// Maintained list of known destinations (e.g. major exchange deposit accounts)
// that require a memo/destination tag to prevent lost funds.

export const MEMO_REQUIRED_DESTINATIONS: readonly string[] = [
  "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EB4YAWBDMW7SJBOMIB6J", // Binance
  "GDQUOAQXF2ZNOYRLCGMWINPPMK3UXOMGVQHGMUMODBCPAG3HNOGJJEOG", // Coinbase
  "GA5XIEFAS3WMNHSKUIQ7IBKZQTQNMOTAMTO366VCGRGS3KNJIL3T2AWF", // Kraken
  "GB6YPGW5JFMMP2QB2USQ33EUWTXVL4ZT5ITNCAT6VBNWB6DQBP3ALQNO", // Bitfinex
];

/**
 * Checks whether a destination address is known or heuristically detected to require
 * a memo (such as an exchange deposit address).
 */
export function isMemoRequiredDestination(destination?: string | null): boolean {
  if (!destination) return false;
  const d = destination.trim().toUpperCase();
  if (MEMO_REQUIRED_DESTINATIONS.includes(d)) return true;
  // Heuristic: addresses with MEMO tag indicators or known exchange tag format
  if (/^G[A-Z0-9]{55}$/.test(d) && (d.endsWith("MEMO") || d.includes("EXCHANGE"))) {
    return true;
  }
  return false;
}
