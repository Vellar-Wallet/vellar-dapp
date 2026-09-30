// History domain types (issue #403, technical-doc.md §5.2).
//
// These are the shapes the dashboard renders. They are deliberately UI-free and
// free of any Stellar SDK types so both the client component and the unit tests
// can depend on them without pulling the SDK in.

export interface HistoryAsset {
  /** soroban = SAC/contract token; classic = classic-asset payment. */
  kind: "soroban" | "classic";
  /**
   * Display symbol — e.g. "XLM", "USDC". ALWAYS present on a rendered row:
   * an amount is never shown without the asset it is denominated in (issue
   * #403 hard requirement). Falls back to "Unknown token" rather than "" so a
   * row can never render a bare number.
   */
  code: string;
  /** 7 for XLM and standard assets; contract tokens carry their own. */
  decimals: number;
  /** SAC/contract id (soroban) or empty for classic assets. */
  contractId: string;
  /** Classic-asset issuer (classic assets only). */
  issuer?: string;
}

export type HistoryDirection = "in" | "out" | "self";

export type HistoryStatus = "success" | "failed";

export interface HistoryTx {
  /**
   * Stable, unique row id. Namespaced per rail (and, for Soroban, per
   * contract) because the two rails' id spaces overlap and two contracts can
   * emit at the same ledger/operation index — the dashboard de-duplicates
   * appended pages by this id, so a collision would silently drop a row.
   */
  id: string;
  kind: "soroban" | "classic";
  direction: HistoryDirection;
  /** The other side of the transfer (empty only for self-transfers). */
  counterparty: string;
  /** Raw units (stroops-style); always rendered together with `asset`. */
  amount: bigint;
  asset: HistoryAsset;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  status: HistoryStatus;
  /** Hex transaction hash, linked to an explorer. */
  txHash: string;
}

export interface HistoryPage {
  rows: HistoryTx[];
  /** Opaque cursor for the next (older) page; undefined when exhausted. */
  nextCursor: string | undefined;
}
