// Pure history parsing/pagination/retry helpers (issue #403). SDK-free by
// design so unit tests exercise them directly; the Stellar decoder is passed in
// explicitly (rather than installed into a module-level global) so every
// consumer — the real client and the tests — decodes through the same path.

import type { HistoryAsset, HistoryDirection, HistoryTx } from "./history-types";

// --- Transient RPC failures (docs/adr-403-transaction-history.md) -------------

export const TRANSIENT_ERROR_CODES = ["txNoAccount", "txBadSeq", "MissingValue"] as const;

/**
 * Substrings that mark a stale/ephemeral view from the public testnet RPC's
 * load balancer. The ledger-range entry is the shape actually observed live
 * (`startLedger must be within the ledger range: A - B`): the node behind the
 * LB advertises a different window than the one we computed against, so the
 * read is retried after re-clamping rather than surfaced as "no history".
 */
const TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  ...TRANSIENT_ERROR_CODES,
  "must be within the ledger range",
  "stale",
];

export class TransientHistoryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Stale RPC view (${code}) — retry may succeed`);
    this.name = "TransientHistoryError";
    this.code = code;
  }
}

export function mapTransientRpcError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const haystack = message.toLowerCase();
  for (const code of TRANSIENT_ERROR_PATTERNS) {
    if (haystack.includes(code.toLowerCase())) return new TransientHistoryError(code);
  }
  return err;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries the documented testnet flake modes: the public RPC's load balancer
 * intermittently serves stale ledger views, so getEvents/getTransaction can
 * answer txNoAccount / txBadSeq / MissingValue for data that exists. Retries
 * with exponential backoff and rethrows the mapped error once attempts run
 * out, so callers can distinguish "empty history" from "temporarily
 * unreadable" instead of rendering a lying empty list.
 *
 * Only transient classes are retried. A 400 (e.g. Horizon rejecting a contract
 * address) is a permanent caller mistake and surfaces on the first attempt.
 */
export async function withTransientRetry<T>(
  run: () => Promise<T>,
  { retries = 4, baseDelayMs = 120, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = mapTransientRpcError(err);
      if (!(lastError instanceof TransientHistoryError) || attempt === retries) {
        throw lastError;
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- base64url for the opaque page cursor (browser-safe) ---------------------
// Buffer is NOT available in the browser bundle (Next.js does not polyfill it)
// and this module runs in client code. btoa/atob cover the browser; Buffer is
// kept only as the Node fallback (unit tests, SSR).

function encodeBase64(input: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(input, "utf8").toString("base64");
}

function decodeBase64(input: string): string {
  if (typeof atob === "function") {
    const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(input, "base64").toString("utf8");
}

// --- Page cursor packing (both rails ride in one opaque string) --------------

export function encodePageCursor(
  events: string | undefined,
  ops: string | undefined,
): string | undefined {
  if (!events && !ops) return undefined;
  const payload: Record<string, string> = {};
  if (events) payload.e = events;
  if (ops) payload.o = ops;
  return encodeBase64(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodePageCursor(
  cursor: string | undefined,
): { events?: string; ops?: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeBase64(cursor));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const out: { events?: string; ops?: string } = {};
    if (typeof record.e === "string") out.events = record.e;
    if (typeof record.o === "string") out.ops = record.o;
    return out.events || out.ops ? out : undefined;
  } catch {
    return undefined;
  }
}

// --- SAC transfer events -----------------------------------------------------
// Verified live against both testnet SACs (docs/adr-403-transaction-history.md):
//   USDC SAC: topic = ["transfer", from, to, "USDC:GBBD…"]   value = i128
//   XLM  SAC: topic = ["transfer", from, to, "native"]         value = i128
// Both also emit unrelated events on the same contracts — "fee" with 2 topics
// and "approve" with 4 — so the match is by topic[0] AND a minimum topic
// count, never by an exact count.

/** The SDK's decoded ScVal → native. Injected so this module stays SDK-free. */
export type ScValDecoder = (scVal: unknown) => unknown;

export interface RawEvent {
  type: string;
  ledger: number;
  ledgerClosedAt?: string;
  id: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topic: unknown[];
  value: unknown;
  /**
   * The contract that emitted the event. `stellar-sdk` hands back a StrKey
   * `Contract` OBJECT here, not a string — callers must normalise with
   * `String(...)` before using it as a lookup key.
   */
  contractId: unknown;
}

function decodeString(decoder: ScValDecoder, scVal: unknown): string | undefined {
  try {
    const value = decoder(scVal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The contract id as a C… string, whatever the SDK handed us. */
export function contractIdOf(event: RawEvent): string {
  return String(event.contractId ?? "");
}

/**
 * A Soroban token transfer event.
 *
 * `topic.length >= 3` is load-bearing: the native XLM SAC and Circle USDC both
 * emit 4 topics, but SEP-41 also permits an implementation that carries the
 * amount in a `value` map behind a single topic. Requiring an exact count (as an
 * earlier draft did) silently dropped real transfers on any contract that
 * differs; requiring >= 3 keeps the 2-topic "fee" events out.
 */
export function isSACTransferEvent(event: RawEvent, decoder: ScValDecoder): boolean {
  return (
    event.type === "contract" &&
    Array.isArray(event.topic) &&
    event.topic.length >= 3 &&
    decodeString(decoder, event.topic[0]) === "transfer"
  );
}

/**
 * The transfer amount, in the asset's base units.
 *
 * The observed SAC shape is a bare i128 `value`. SEP-41 also permits a
 * structured value, so a map/vec carrying an `amount` key is unwrapped
 * defensively rather than dropped.
 */
function extractAmount(decoder: ScValDecoder, value: unknown, depth = 0): bigint | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "bigint") return value;
  let native: unknown;
  try {
    native = decoder(value);
  } catch {
    return undefined;
  }
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isFinite(native)) return BigInt(Math.trunc(native));
  if (typeof native === "string" && /^-?\d+$/.test(native)) {
    try {
      return BigInt(native);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(native)) {
    for (const element of native) {
      const found = extractAmount(decoder, element, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof native === "object" && native !== null && "amount" in native) {
    return extractAmount(decoder, (native as { amount: unknown }).amount, depth + 1);
  }
  return undefined;
}

export function parseSACTransfer(
  accountId: string,
  event: RawEvent,
  asset: HistoryAsset,
  decoder: ScValDecoder,
): HistoryTx | undefined {
  if (!isSACTransferEvent(event, decoder)) return undefined;
  const from = decodeString(decoder, event.topic[1]);
  const to = decodeString(decoder, event.topic[2]);
  if (!from || !to) return undefined;
  const amount = extractAmount(decoder, event.value);
  if (amount === undefined) return undefined;
  const contractId = contractIdOf(event);
  return {
    // Namespaced: event ids are only unique within one contract's emission, and
    // this id is the dashboard's de-duplication key across appended pages.
    id: `soroban:${contractId}:${event.id}`,
    kind: "soroban",
    direction: directionFor(accountId, from, to),
    counterparty: from === accountId ? to : from,
    amount,
    asset,
    timestamp: event.ledgerClosedAt ?? new Date(0).toISOString(),
    // A reverted contract call still tells the user "this did not go through",
    // which is exactly the question the history view exists to answer.
    status: event.inSuccessfulContractCall ? "success" : "failed",
    txHash: event.txHash,
  };
}

// --- Classic operations (Horizon ops endpoint) --------------------------------

export interface ClassicOp {
  id: string;
  type: string;
  transaction_successful: boolean;
  created_at: string;
  transaction_hash: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  from?: string;
  to?: string;
  account?: string;
  starting_balance?: string;
  /** Horizon's forward-only page token for the operations collection. */
  paging_token?: string;
}

export const NATIVE_DECIMALS = 7;

export function classicOpToRow(accountId: string, op: ClassicOp): HistoryTx | undefined {
  const asset = classicAssetOf(op);
  if (!asset) return undefined;

  let counterparty = "";
  let direction: HistoryDirection = "self";
  let amount = 0n;

  if (op.type === "payment" || op.type.startsWith("path_payment")) {
    if (!op.amount) return undefined;
    counterparty = op.from === accountId ? (op.to ?? "") : (op.from ?? "");
    direction = directionFor(accountId, op.from, op.to);
    amount = decimalToRaw(op.amount);
  } else if (op.type === "create_account") {
    if (!op.starting_balance) return undefined;
    counterparty = op.account ?? "";
    direction = op.from === accountId ? "out" : "in";
    amount = decimalToRaw(op.starting_balance);
  } else if (op.type === "account_merge") {
    counterparty = op.account ?? "";
    direction = op.from === accountId ? "out" : "in";
  } else {
    // Trustline changes, set_options, invoke_host_function, etc. are not
    // transfer-shaped and carry no amount to show.
    return undefined;
  }

  return {
    // Namespaced so a classic op can never collide with a Soroban event id.
    id: `classic:${op.id}`,
    kind: "classic",
    direction,
    counterparty,
    amount,
    asset,
    timestamp: op.created_at,
    // A failed classic tx is rolled back, so it is shown as an explicit
    // "failed" attempt rather than omitted — the user asked whether it went
    // through, and silence would be the wrong answer.
    status: op.transaction_successful ? "success" : "failed",
    txHash: op.transaction_hash,
  };
}

function classicAssetOf(op: ClassicOp): HistoryAsset | undefined {
  if (op.asset_type === "native") {
    return { kind: "classic", code: "XLM", decimals: NATIVE_DECIMALS, contractId: "" };
  }
  if (op.asset_code && op.asset_issuer) {
    return {
      kind: "classic",
      code: op.asset_code,
      decimals: NATIVE_DECIMALS,
      contractId: "",
      issuer: op.asset_issuer,
    };
  }
  return undefined;
}

/** "12.0000004" → 120000004n (Horizon decimal amounts are exact 7dp strings). */
export function decimalToRaw(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, frac = ""] = unsigned.split(".");
  const paddedFrac = frac.padEnd(NATIVE_DECIMALS, "0").slice(0, NATIVE_DECIMALS);
  const raw = BigInt(`${whole}${paddedFrac}` || "0");
  return negative ? -raw : raw;
}

function directionFor(
  accountId: string,
  from: string | undefined,
  to: string | undefined,
): HistoryDirection {
  const isFrom = from === accountId;
  const isTo = to === accountId;
  if (isFrom && !isTo) return "out";
  if (isTo && !isFrom) return "in";
  return "self";
}

// --- Merged pagination --------------------------------------------------------

export interface MergeInput {
  accountId: string;
  events: RawEvent[];
  ops: ClassicOp[];
  /** Resolved asset per contract id; unresolved ids drop their rows rather
   *  than render an amount without an asset (issue #403 hard requirement). */
  assetOf: (contractId: string) => HistoryAsset | undefined;
  pageSize: number;
  decoder: ScValDecoder;
}

// --- Per-rail paging ----------------------------------------------------------
//
// WHY NOT ONE MERGED SORT. The obvious shape — merge both rails, sort by
// timestamp, slice to pageSize — is subtly wrong, and the defect is invisible
// until it is read closely.
//
// getEvents returns events in ASCENDING order and its cursor walks FORWARD
// toward the chain head; there is no "latest N" mode and `order: "desc"` was
// verified to be ignored. So a forward cursor cannot serve a newest-first page
// from the tail of a stream without stranding everything before it. Worse,
// `ledgerClosedAt` does not always order events the way the stream does:
// verified live, a scanned window interleaved ledgers 920976 and 920988 such
// that the 920988 row sorted NEWEST while sitting at the END of the stream.
// Taking "the oldest emitted row by timestamp" as a resume point then skipped
// the rest of 920976 and re-read 920988 from its start — re-emitting a row the
// first page had already shown. That is exactly the "re-serving the same page"
// defect class, and it reproduced intermittently because it depends on where a
// ledger boundary happens to fall inside a scan.
//
// So each rail is paged on its own terms: the Soroban rail reverses its
// ascending stream (newest first) and never trims, because the caller resumes
// from the window's oldest ledger and would otherwise have no way to reach a
// trimmed row; the classic rail trims against Horizon's own newest-first
// cursor, which can express the resume point. Only the final display order is a
// timestamp sort.

export interface RailPage {
  /** Newest-first rows for this rail, at most `pageSize` of them. */
  rows: HistoryTx[];
  /** Cursor to resume this rail after; undefined when the rail is drained. */
  resume: string | undefined;
}

/**
 * Builds the Soroban rail for one page.
 *
 * `events` MUST be in the order getEvents returned them (ascending, oldest
 * first) and MUST cover a complete ledger window — that is what makes this
 * correct. The window's newest transfers are its LAST entries, so they are
 * rendered by reversing the stream. Nothing is trimmed off the end, because a
 * trimmed row would have no way to reach the next page: the cursor moves
 * backwards by ledger, so every transfer in the window is either shown now or
 * re-derived in the following window. `resume` is therefore never derived here;
 * the caller resumes from the window's oldest ledger.
 */
export function buildSorobanRail(input: {
  accountId: string;
  events: RawEvent[];
  assetOf: (contractId: string) => HistoryAsset | undefined;
  decoder: ScValDecoder;
}): HistoryTx[] {
  const rows: HistoryTx[] = [];
  for (const event of input.events) {
    if (!isSACTransferEvent(event, input.decoder)) continue;
    const asset = input.assetOf(contractIdOf(event));
    if (!asset) continue;
    const row = parseSACTransfer(input.accountId, event, asset, input.decoder);
    if (row) rows.push(row);
  }
  // Ascending stream → newest first.
  return rows.reverse();
}

/**
 * Pages the classic rail. Horizon is queried `order("desc")`, so `ops` arrives
 * newest-first and the resume point is the paging token of the last emitted
 * operation. Operations that are not payments are dropped, which is why the
 * token is taken from the last EMITTED row rather than the last record.
 */
export function buildClassicRail(input: {
  accountId: string;
  ops: ClassicOp[];
  pageSize: number;
}): RailPage {
  const rows: HistoryTx[] = [];
  for (const op of input.ops) {
    const row = classicOpToRow(input.accountId, op);
    if (row) rows.push(row);
  }
  if (rows.length <= input.pageSize) return { rows, resume: undefined };

  const last = rows[input.pageSize - 1];
  const lastOpId = last?.id.slice("classic:".length);
  const resume = input.ops.find((o) => String(o.id) === lastOpId)?.paging_token;
  return { rows: rows.slice(0, input.pageSize), resume };
}/**
 * Merges a page of rows from both rails into one newest-first list for display.
 * Paging itself is per-rail (buildSorobanRail / buildClassicRail); this is only
 * the ordering the UI renders.
 */
export function mergeHistoryPages(  input: MergeInput,
): { rows: HistoryTx[]; pageHasMore: boolean } {
  const rows: HistoryTx[] = [];
  for (const event of input.events) {
    if (!isSACTransferEvent(event, input.decoder)) continue;
    const asset = input.assetOf(contractIdOf(event));
    if (!asset) continue;
    const row = parseSACTransfer(input.accountId, event, asset, input.decoder);
    if (row) rows.push(row);
  }
  for (const op of input.ops) {
    const row = classicOpToRow(input.accountId, op);
    if (row) rows.push(row);
  }
  // Date.parse rather than string compare: the two rails format timestamps
  // independently (Soroban `ledgerClosedAt`, Horizon `created_at`), and any
  // offset or precision difference would mis-order a string comparison.
  rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { rows: rows.slice(0, input.pageSize), pageHasMore: rows.length > input.pageSize };
}
