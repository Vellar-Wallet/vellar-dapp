import type { Network } from "@vellar/types";
import type { HistoryAsset, HistoryPage } from "./history-types";
import {
  contractIdOf,
  buildClassicRail,
  buildSorobanRail,
  decodePageCursor,
  encodePageCursor,
  isSACTransferEvent,
  withTransientRetry,
  type ClassicOp,
  type RawEvent,
  type ScValDecoder,
} from "./history-parse";

// Transaction history client for the smart account (issue #403;
// technical-doc.md §5.2/§7.4).
//
// Data source: Soroban RPC getEvents as the PRIMARY rail, Horizon's operations
// endpoint as a SECONDARY rail for classic G-accounts. The full rationale,
// including the two behaviours verified live against testnet, is in
// docs/adr-403-transaction-history.md. In short:
//
//  * Soroban/SAC transfers are contract EVENTS. Horizon does not serve them.
//    Verified: GET /accounts/{C…}/operations answers 400 Bad Request, so a
//    Horizon-only implementation shows nothing at all for the smart accounts
//    this wallet actually creates.
//  * The classic rail is therefore gated on the address actually being classic
//    (a G…). Querying a C-address unconditionally is not a harmless extra
//    request — it is a hard 400 that fails the whole page.
//
// Pure helpers (parsing/retry/cursors) live in history-parse.ts so unit tests
// run without the SDK; this module wires the real client, and component tests
// mock HistoryClient the way they mock balances.ts.

const DEFAULT_PAGE_SIZE = 20;
/**
 * Ledger window per page (~2.5 minutes at ~5s ledgers). Windows are disjoint
 * and march backwards; see the Rail 1 note for why a forward cursor cannot page
 * a newest-first view.
 */
const WINDOW_LEDGERS = 32;
/** Raw events requested per scan request (the node's practical ceiling). */
const SCAN_PAGE_SIZE = 100;
/**
 * How many scan requests one window may cost. Bounded so a very busy ledger
 * range cannot turn one page into an unbounded crawl.
 *
 * On a very busy range the budget can run out before the window's end is
 * reached, which is a deliberate trade: the page then shows slightly older
 * history rather than making N sequential requests. Correctness is unaffected,
 * because the resume ledger is the oldest event ACTUALLY consumed, so nothing
 * between the two windows is ever skipped.
 */
const MAX_SCAN_PAGES = 8;
/** How many times one page may widen its window before settling. */
const WINDOW_ATTEMPTS = 2;
const ASSET_CACHE_LIMIT = 512;
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface HistoryClient {
  fetchPage(args: {
    accountId: string;
    network: Network;
    cursor?: string;
    pageSize?: number;
  }): Promise<HistoryPage>;
}

type StellarSdk = typeof import("@stellar/stellar-sdk");

/** A classic account id starts with G; a smart account is a C… contract. */
function isClassicAccount(accountId: string): boolean {
  return accountId.startsWith("G");
}

export function createHistoryClient(config: {
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
}): HistoryClient {
  // The SDK is heavy and off the onboarding path — lazy-load like balances.ts.
  let sdkPromise: Promise<StellarSdk> | undefined;
  const loadSdk = () => (sdkPromise ??= import("@stellar/stellar-sdk"));

  const assetCache = new Map<string, Promise<HistoryAsset | undefined>>();

  /**
   * Assets this wallet can already name without a network round-trip. Both
   * SACs are pinned per network in vellar-sdk, so the common case costs zero
   * simulations and the issuer-pinned USDC id can never be swapped for an
   * impostor asset that also calls itself "USDC".
   */
  async function knownAsset(
    lib: StellarSdk,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const { TESTNET } = await import("vellar-sdk");
    const candidates: Array<{ contractId: string; code: string; decimals: number }> = [
      { contractId: TESTNET.nativeTokenContractId, code: "XLM", decimals: 7 },
      { contractId: TESTNET.usdcContractId, code: "USDC", decimals: 7 },
    ];
    const hit = candidates.find((c) => c.contractId === contractId);
    if (!hit) return undefined;
    return { kind: "soroban", code: hit.code, decimals: hit.decimals, contractId };
  }

  function resolveAsset(
    lib: StellarSdk,
    rpcServer: InstanceType<StellarSdk["rpc"]["Server"]>,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const cached = assetCache.get(contractId);
    if (cached) return cached;
    const pending = resolveAssetUncached(lib, rpcServer, contractId).catch(() => undefined);
    if (assetCache.size < ASSET_CACHE_LIMIT) assetCache.set(contractId, pending);
    return pending;
  }

  async function resolveAssetUncached(
    lib: StellarSdk,
    rpcServer: InstanceType<StellarSdk["rpc"]["Server"]>,
    contractId: string,
  ): Promise<HistoryAsset | undefined> {
    const known = await knownAsset(lib, contractId);
    if (known) return known;

    // Unknown contract: ask it for symbol()/decimals() via read-only simulation
    // on a synthetic source account — the same trick balances.ts uses for
    // balance reads. Verified working against the live USDC SAC.
    const call = async (fn: "symbol" | "decimals"): Promise<unknown> => {
      const tx = new lib.TransactionBuilder(new lib.Account(SIMULATION_SOURCE, "0"), {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          lib.Operation.invokeContractFunction({ contract: contractId, function: fn, args: [] }),
        )
        .setTimeout(60)
        .build();
      const sim = await withTransientRetry(() => rpcServer.simulateTransaction(tx));
      if (!lib.rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
      return lib.scValToNative(sim.result.retval);
    };
    const [symbol, decimals] = await Promise.all([call("symbol"), call("decimals")]);
    if (typeof symbol !== "string" || typeof decimals !== "number" || decimals < 0) {
      return undefined;
    }
    return { kind: "soroban", code: symbol, decimals, contractId };
  }

  return {
    async fetchPage({ accountId, network, cursor, pageSize = DEFAULT_PAGE_SIZE }) {
      void network; // endpoints are already network-scoped via config
      const lib = await loadSdk();
      const decoder: ScValDecoder = (scVal) => lib.scValToNative(scVal as never);
      const pack = decodePageCursor(cursor);
      const rpcServer = new lib.rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });

      // --- Rail 1: SAC transfer events (getEvents) ----------------------------
      // WHY THIS IS SHAPED THE WAY IT IS — all three points below were
      // verified live against soroban-testnet, not inferred from docs.
      //
      // 1. `order` is useless. It is not in the SDK's GetEventsRequest, and an
      //    identical request carrying `order: "desc"` came back with the same
      //    ascending page. There is no "latest N events" mode.
      // 2. `getEvents({ startLedger })` returns the OLDEST events at or after
      //    that ledger, ASCENDING, and its cursor walks FORWARD toward the
      //    chain head. Verified: a request for startLedger = latest - 1000
      //    came back entirely from ledger latest - 1000, not from the head.
      //    So the old implementation — start the lookback window well in the
      //    past and page forward — was showing a wallet the OLDEST transfers
      //    of its window while labelling the panel newest-first.
      // 3. Server-side topic filters are unreliable here: a filter that should
      //    have matched returned 0 events on a window where the unfiltered
      //    query returned 200 matching transfers, and the plain-string topic
      //    form is rejected outright ("decoding ScValType: '-1229543503' is not
      //    a valid ScValType enum value"). Events are discriminated
      //    client-side, so a raw page is mostly NOT transfers — the same
      //    range also carries `fee` and `approve` events.
      //// Together these mean a FORWARD cursor cannot produce newest-first pages:
// taking the tail of the stream discards everything before it, and
      // taking the head shows the oldest history. So each page instead reads an
      // explicit ledger WINDOW and renders it newest-first by reversing the
      // ascending stream. "Load older" reads the window that ends at the ledger
      // immediately BEFORE the oldest event the previous window actually
      // consumed, so windows are disjoint, progress is strictly backwards, and
      // nothing is re-read or skipped.
      //
      // The cursor therefore carries BOTH window bounds. Carrying only the
      // start was a real defect: when the scan budget truncated a window, the
      // next window — computed as [start-1, start+WINDOW-1] — overlapped the
      // truncated remainder of the previous one and re-served ~100 rows.
      //
      // The first window ends at the chain head, so page one is the newest
      // history there is. If it yields fewer transfers than a page holds it is
      // widened backwards (bounded) — otherwise a quiet wallet would show "No
      // transactions yet" while plainly having recent transfers, which is the
      // failure mode issue #403 calls out.
      let eventPage: { events: RawEvent[]; nextFrom: number; nextTo: number };
      let oldestRetained = 0;
      {
        const health = await withTransientRetry(() => rpcServer.getHealth());
        const latest = health.latestLedger;
        oldestRetained = Math.min(health.oldestLedger ?? 1, latest);

        // "<from>:<to>" — the window this page reads. Absent on the first page.
        const carried = (pack?.events ?? "").split(":");
        const carriedFrom = Number(carried[0]) || 0;
        const carriedTo = Number(carried[1]) || 0;
        let fromLedger = carriedFrom || Math.max(oldestRetained, latest - WINDOW_LEDGERS);
        let windowEnd = carriedTo || latest;
        let widened = false;
        let events: RawEvent[] = [];
        let oldestSeen: number | undefined;
        let scannedCursor: string | undefined;

        for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt++) {
          events = [];
          oldestSeen = undefined;
          scannedCursor = undefined;
          // Read the window. The first request pins the ledger range; the rest
          // continue it, because the node rejects a request carrying both
          // ("ledger ranges and cursor cannot both be set").
          for (let page = 0; page < MAX_SCAN_PAGES; page++) {
            const res = await withTransientRetry(() =>
              rpcServer.getEvents({
                ...(page === 0
                  ? { startLedger: fromLedger, endLedger: windowEnd }
                  : { cursor: scannedCursor }),
                limit: SCAN_PAGE_SIZE,
                filters: [],
              } as never),
            );
            const scanned = res as unknown as { events: RawEvent[]; cursor?: string };
            events.push(...(scanned.events ?? []));
            scannedCursor = scanned.cursor;
            if (scanned.cursor === undefined) break; // reached the window's end
          }
          oldestSeen = events[0]?.ledger;

          const transfers = events.filter((e) => isSACTransferEvent(e, decoder)).length;
          if (transfers >= pageSize || widened || carriedFrom) break;
          // Too quiet a window: widen it. Bounded so one page cannot crawl.
          widened = true;
          fromLedger = Math.max(oldestRetained, fromLedger - WINDOW_LEDGERS);
          windowEnd = latest;
          if (fromLedger <= oldestRetained) break;
        }

        // The next window ENDS at the ledger before the oldest event this
        // window consumed — never at a computed offset from where it started,
        // which is what made truncated windows overlap. An empty window steps
        // back past itself so "Load older" still makes progress.
        const nextTo =
          oldestSeen !== undefined
            ? oldestSeen - 1
            : Math.max(oldestRetained, fromLedger - 1);
        eventPage = {
          events,
          nextFrom: Math.max(oldestRetained, nextTo - WINDOW_LEDGERS + 1),
          nextTo,
        };
      }

      // --- Rail 2: classic operations (Horizon, cursor-paginated) -----------
      // Classic accounts only. Horizon answers 400 for a C-address, and an
      // unconditional call here would fail the entire page for every smart
      // wallet — the one account type this feature is for.
      let classicOps: ClassicOp[] = [];
      let opsExhausted = true;
      if (isClassicAccount(accountId)) {
        const horizonServer = new lib.Horizon.Server(config.horizonUrl, {
          allowHttp: config.horizonUrl.startsWith("http://"),
        });
        const opsBuilder = horizonServer
          .operations()
          .forAccount(accountId)
          .limit(pageSize)
          .order("desc");
        const opsPage = await withTransientRetry(() =>
          (pack?.ops ? opsBuilder.cursor(pack.ops) : opsBuilder).call(),
        );
        classicOps = opsPage.records as unknown as ClassicOp[];
        opsExhausted = classicOps.length < pageSize;
      }

      // Resolve every SAC contract id on this page BEFORE merging so rows
      // never render an amount without its asset (issue #403 hard rule).
      const contractIds = new Set(
        eventPage.events.filter((e) => e.type === "contract").map(contractIdOf),
      );
      const resolved = new Map<string, HistoryAsset | undefined>();
      await Promise.all(
        [...contractIds].map(async (contractId) => {
          resolved.set(contractId, await resolveAsset(lib, rpcServer, contractId));
        }),
      );

      const assetOf = (contractId: string) => resolved.get(contractId);

      // Page each rail in ITS OWN stream order, then concatenate. See the long
      // note above buildSorobanRail: merging both rails and slicing once by
      // timestamp drops rows that neither rail's cursor accounts for, which is
      // the security-audit L6/L6b defect class ("no row may be skipped and no
      // row may be re-served"). pageSize is a per-rail budget, so a page holds
      // up to pageSize rows per rail.
      const sorobanRows = buildSorobanRail({
        accountId,
        events: eventPage.events,
        assetOf,
        decoder,
      });
      const classic = buildClassicRail({ accountId, ops: classicOps, pageSize });

      // Display order only; paging above already fixed both rails' positions.
      const rows = [...sorobanRows, ...classic.rows].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      );

      // --- resume points -----------------------------------------------------
      // Soroban: the ledger immediately BEFORE the oldest event this window
      // saw. Older pages resume there, so the windows march strictly backwards
      // and no ledger is scanned twice.
      const eventsCursorNext =
        eventPage.nextTo > oldestRetained
          ? `${eventPage.nextFrom}:${eventPage.nextTo}`
          : undefined;
      // Classic: the paging token of the oldest emitted operation, else the
      // last operation Horizon returned (payments are dropped, so those are
      // not interchangeable).
      const opsCursorNext = classic.resume ?? classicOps.at(-1)?.paging_token;

      const eventsExhausted = eventsCursorNext === undefined;
      // Continue while EITHER rail has more; the packed cursor carries both
      // positions so the next page resumes exactly here (security-audit L6:
      // no rail may be re-scrolled from the top).
      const nextCursor =
        eventsExhausted && opsExhausted ? undefined : encodePageCursor(eventsCursorNext, opsCursorNext);

      return { rows, nextCursor };
    },
  };
}
