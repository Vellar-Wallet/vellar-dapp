import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildClassicRail,
  buildSorobanRail,
  classicOpToRow,
  contractIdOf,
  decimalToRaw,
  decodePageCursor,
  encodePageCursor,
  isSACTransferEvent,
  mapTransientRpcError,
  mergeHistoryPages,
  parseSACTransfer,
  TransientHistoryError,
  withTransientRetry,
  type ClassicOp,
  type RawEvent,
} from "./history-parse";
import type { HistoryAsset } from "./history-types";

// Unit tests for the pure history helpers (issue #403 acceptance: "Unit tests
// for parsing/pagination").
//
// The Soroban fixtures below are NOT hand-written stand-ins. The topic and
// value base64 blobs were captured verbatim from live testnet `getEvents`
// responses (Circle USDC SAC and the native XLM SAC) and are re-decoded here
// through the real `xdr.ScVal` + `scValToNative` path the client uses, so a
// change in how the wire format is read fails these tests rather than only
// surfacing against the network. See docs/adr-403-transaction-history.md.

const decode = (scVal: unknown) => scValToNative(scVal as never);

// --- Live testnet fixtures ---------------------------------------------------

/** Real USDC SAC transfer, 4 topics, 2777.2565 USDC. */
const USDC_EVENT = {
  id: "0021081069583364096-0000000016",
  txHash: "a040266d75503252be1e39ed2367e489a06f83462e44b058f6b009ac7989fcd3",
  ledgerClosedAt: "2026-09-28T03:13:02Z",
  contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  inSuccessfulContractCall: true,
  topicBase64: [
    "AAAADwAAAAh0cmFuc2Zlcg==",
    "AAAAEgAAAAEw8EBqbZh4gmqnRw3r9RnrGSKq/Q1bT0DsqZFQs10Pcw==",
    "AAAAEgAAAAAAAAAAw3BztA207dD6ilwnBvExGIf3/OxhFDc51Y6iCOdSqWE=",
    "AAAADgAAAD1VU0RDOkdCQkQ0N0lGNkxXSzdQN01ERVZTQ1dSN0RQVVdWM05ZM0RUUUVWRkw0TkFUNEFRSDNaTExGTEE1AAAA",
  ],
  valueBase64: "AAAACgAAAAAAAAAAAAAABndftgg=",
  from: "CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA",
  to: "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH",
  amount: 27_772_565_000n,
} as const;

/** Real native XLM SAC transfer, 4 topics, 10000 XLM. */
const XLM_EVENT = {
  id: "0021081073878319104-0000000000",
  txHash: "52bf6214d735df66a19f91d244efb46f1cf76b597658712f6342cddacc1d6053",
  ledgerClosedAt: "2026-09-28T03:13:07Z",
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  inSuccessfulContractCall: true,
  topicBase64: [
    "AAAADwAAAAh0cmFuc2Zlcg==",
    "AAAAEgAAAAAAAAAAEH3Rayw4M0iCLoEe96rPFNGYim8AVHJU0z4ebYZW4Jw=",
    "AAAAEgAAAAAAAAAAPQT3yr9JbnROR9HTlztKzztxp2KAL8XAo37yu46FONk=",
    "AAAADgAAAAZuYXRpdmUAAA==",
  ],
  valueBase64: "AAAACgAAAAAAAAAAAAAAF0h26AA=",
  from: "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR",
  to: "GA6QJ56KX5EW45COI7I5HFZ3JLHTW4NHMKAC7ROAUN7PFO4OQU4NT7MB",
  amount: 100_000_000_000n,
} as const;

const USDC_CONTRACT = USDC_EVENT.contractId;
const XLM_CONTRACT = XLM_EVENT.contractId;

/** Rebuilds a RawEvent the way stellar-sdk hands one to the client. */
function liveEvent(
  fixture: typeof USDC_EVENT | typeof XLM_EVENT,
  overrides: Partial<RawEvent> = {},
): RawEvent {
  return {
    type: "contract",
    ledger: 4_908_261,
    ledgerClosedAt: fixture.ledgerClosedAt,
    id: fixture.id,
    txHash: fixture.txHash,
    inSuccessfulContractCall: fixture.inSuccessfulContractCall,
    topic: fixture.topicBase64.map((b64) => xdr.ScVal.fromXDR(b64, "base64")),
    value: xdr.ScVal.fromXDR(fixture.valueBase64, "base64"),
    contractId: fixture.contractId,
    ...overrides,
  };
}

const USDC_ASSET: HistoryAsset = {
  kind: "soroban",
  code: "USDC",
  decimals: 7,
  contractId: USDC_CONTRACT,
};
const XLM_ASSET: HistoryAsset = {
  kind: "soroban",
  code: "XLM",
  decimals: 7,
  contractId: XLM_CONTRACT,
};

function classicPayment(overrides: Partial<ClassicOp> = {}): ClassicOp {
  return {
    id: "1234567890",
    type: "payment",
    transaction_successful: true,
    created_at: "2026-09-23T10:00:00Z",
    transaction_hash: "aa".repeat(32),
    asset_type: "native",
    from: "GACCOUNT0000000000000000000000000000000000000000000000000AAAA",
    to: "GOTHER1111111111111111111111111111111111111111111111111111111AAAA",
    amount: "10.0000000",
    paging_token: "21115403551948801",
    ...overrides,
  };
}

const ACCOUNT = "GACCOUNT0000000000000000000000000000000000000000000000000AAAA";

// --- Event recognition ------------------------------------------------------

describe("isSACTransferEvent (real testnet shapes)", () => {
  it("accepts the live Circle USDC SAC transfer", () => {
    expect(isSACTransferEvent(liveEvent(USDC_EVENT), decode)).toBe(true);
  });

  it("accepts the live native XLM SAC transfer", () => {
    expect(isSACTransferEvent(liveEvent(XLM_EVENT), decode)).toBe(true);
  });

  it("accepts a transfer carrying only the minimum from/to topics", () => {
    // SEP-41 permits an implementation that keeps the amount in `value`
    // behind a single topic; an exact-topic-count match would drop it.
    const event = liveEvent(USDC_EVENT, { topic: liveEvent(USDC_EVENT).topic.slice(0, 3) });
    expect(isSACTransferEvent(event, decode)).toBe(true);
  });

  it("rejects the 2-topic 'fee' events the XLM SAC also emits", () => {
    const base = liveEvent(XLM_EVENT);
    const event = liveEvent(XLM_EVENT, {
      topic: [xdr.ScVal.scvSymbol("fee"), base.topic[1]],
    });
    expect(isSACTransferEvent(event, decode)).toBe(false);
  });

  it("rejects 'approve' events even though they carry 4 topics", () => {
    const base = liveEvent(USDC_EVENT);
    const event = liveEvent(USDC_EVENT, {
      topic: [xdr.ScVal.scvSymbol("approve"), ...base.topic.slice(1)],
    });
    expect(isSACTransferEvent(event, decode)).toBe(false);
  });

  it("rejects non-contract events", () => {
    expect(isSACTransferEvent(liveEvent(USDC_EVENT, { type: "system" }), decode)).toBe(false);
  });
});

// --- Parsing ----------------------------------------------------------------

describe("parseSACTransfer", () => {
  it("decodes the live USDC transfer: amount, asset, hash and timestamp", () => {
    const row = parseSACTransfer(USDC_EVENT.from, liveEvent(USDC_EVENT), USDC_ASSET, decode);
    expect(row).toBeDefined();
    expect(row!.direction).toBe("out");
    expect(row!.counterparty).toBe(USDC_EVENT.to);
    expect(row!.amount).toBe(USDC_EVENT.amount);
    expect(row!.asset).toEqual(USDC_ASSET); // an amount is never shown without its asset
    expect(row!.status).toBe("success");
    expect(row!.txHash).toBe(USDC_EVENT.txHash);
    expect(row!.timestamp).toBe(USDC_EVENT.ledgerClosedAt);
  });

  it("decodes the live XLM SAC transfer the same way", () => {
    const row = parseSACTransfer(XLM_EVENT.to, liveEvent(XLM_EVENT), XLM_ASSET, decode);
    expect(row!.direction).toBe("in");
    expect(row!.amount).toBe(XLM_EVENT.amount);
    expect(row!.asset.code).toBe("XLM");
  });

  it("marks a self-transfer", () => {
    const event = liveEvent(USDC_EVENT);
    const selfEvent = liveEvent(USDC_EVENT, {
      topic: [event.topic[0], event.topic[1], event.topic[1]],
    });
    const row = parseSACTransfer(USDC_EVENT.from, selfEvent, USDC_ASSET, decode);
    expect(row!.direction).toBe("self");
  });

  it("surfaces a reverted contract call as a failed row, not a missing one", () => {
    const row = parseSACTransfer(
      USDC_EVENT.from,
      liveEvent(USDC_EVENT, { inSuccessfulContractCall: false }),
      USDC_ASSET,
      decode,
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
    expect(row!.amount).toBe(USDC_EVENT.amount);
  });

  it("returns undefined when from/to do not decode to addresses", () => {
    const event = liveEvent(USDC_EVENT, {
      topic: [liveEvent(USDC_EVENT).topic[0], xdr.ScVal.scvI32(7), liveEvent(USDC_EVENT).topic[2]],
    });
    expect(parseSACTransfer(ACCOUNT, event, USDC_ASSET, decode)).toBeUndefined();
  });
});

describe("contractIdOf", () => {
  it("normalises the StrKey object stellar-sdk returns into a C… string", () => {
    // Verified live: getEvents hands back a `Contract` (StrKey wrapper) object,
    // so using it directly as a Map key or string is a type lie that silently
    // misses every lookup.
    const sdkContract = {
      toString: () => USDC_CONTRACT,
    } as unknown;
    expect(typeof contractIdOf(liveEvent(USDC_EVENT, { contractId: sdkContract }))).toBe("string");
    expect(contractIdOf(liveEvent(USDC_EVENT, { contractId: sdkContract }))).toBe(USDC_CONTRACT);
  });

  it("passes a plain string through unchanged", () => {
    expect(contractIdOf(liveEvent(USDC_EVENT))).toBe(USDC_CONTRACT);
  });
});

// --- Classic rail ------------------------------------------------------------

describe("classicOpToRow", () => {
  it("parses a classic XLM payment with its native asset", () => {
    const row = classicOpToRow(ACCOUNT, classicPayment());
    expect(row!.kind).toBe("classic");
    expect(row!.asset.code).toBe("XLM");
    expect(row!.amount).toBe(100_000_000n);
    expect(row!.direction).toBe("out");
    expect(row!.counterparty).toBe("GOTHER1111111111111111111111111111111111111111111111111111111AAAA");
  });

  it("parses a credit-alphanum payment carrying code and issuer", () => {
    const row = classicOpToRow(
      ACCOUNT,
      classicPayment({
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
      }),
    );
    expect(row!.asset).toMatchObject({ code: "USDC", issuer: "GISSUER" });
  });

  it("parses create_account from starting_balance", () => {
    const row = classicOpToRow(
      ACCOUNT,
      classicPayment({
        type: "create_account",
        starting_balance: "5.5000000",
        account: "GOTHER1111111111111111111111111111111111111111111111111111111AAAA",
      }),
    );
    expect(row!.amount).toBe(55_000_000n);
    expect(row!.direction).toBe("out");
  });

  it("surfaces a rolled-back payment as an explicit failed row", () => {
    // The user asked "did my payment go through?" — dropping the attempt would
    // answer that question with silence.
    const row = classicOpToRow(ACCOUNT, classicPayment({ transaction_successful: false }));
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
  });

  it("skips operations that carry no amount to show", () => {
    expect(classicOpToRow(ACCOUNT, classicPayment({ type: "set_options" }))).toBeUndefined();
    expect(classicOpToRow(ACCOUNT, classicPayment({ type: "invoke_host_function" }))).toBeUndefined();
    // A payment with no asset information would render a bare number.
    expect(classicOpToRow(ACCOUNT, classicPayment({ asset_type: undefined }))).toBeUndefined();
  });
});

describe("decimalToRaw", () => {
  it("converts Horizon decimal strings exactly", () => {
    expect(decimalToRaw("12.0000004")).toBe(120_000_004n);
    expect(decimalToRaw("10.0000000")).toBe(100_000_000n);
    expect(decimalToRaw("10")).toBe(100_000_000n);
    expect(decimalToRaw("0.0000001")).toBe(1n);
    expect(decimalToRaw("100")).toBe(1_000_000_000n);
  });
});

// --- Merged pagination -------------------------------------------------------

describe("mergeHistoryPages", () => {
  it("sorts both rails into one newest-first stream", () => {
    const older = liveEvent(USDC_EVENT, { ledgerClosedAt: "2026-09-20T00:00:00Z" });
    const { rows } = mergeHistoryPages({
      accountId: USDC_EVENT.to,
      events: [older, liveEvent(USDC_EVENT)],
      ops: [classicPayment()],
      assetOf: (id) => (id === USDC_CONTRACT ? USDC_ASSET : undefined),
      pageSize: 20,
      decoder: decode,
    });
    expect(rows.map((r) => r.timestamp)).toEqual([
      USDC_EVENT.ledgerClosedAt, // 2026-09-28T03:13:02Z
      "2026-09-23T10:00:00Z", // classic
      "2026-09-20T00:00:00Z",
    ]);
  });

  it("trims to pageSize and reports that more remain", () => {
    const { rows, pageHasMore } = mergeHistoryPages({
      accountId: USDC_EVENT.to,
      events: [liveEvent(USDC_EVENT)],
      ops: [
        classicPayment(),
        classicPayment({ id: "2", created_at: "2026-09-22T00:00:00Z" }),
      ],
      assetOf: () => USDC_ASSET,
      pageSize: 2,
      decoder: decode,
    });
    expect(rows).toHaveLength(2);
    expect(pageHasMore).toBe(true);
  });

  it("drops Soroban rows whose asset could not be resolved", () => {
    // Never display an amount without its asset: an unresolvable contract
    // loses the row rather than the label.
    const { rows } = mergeHistoryPages({
      accountId: USDC_EVENT.to,
      events: [liveEvent(USDC_EVENT)],
      ops: [],
      assetOf: () => undefined,
      pageSize: 20,
      decoder: decode,
    });
    expect(rows).toHaveLength(0);
  });

  it("gives rows from different contracts distinct ids", () => {
    const { rows } = mergeHistoryPages({
      accountId: USDC_EVENT.to,
      events: [liveEvent(USDC_EVENT), liveEvent(XLM_EVENT)],
      ops: [],
      assetOf: (id) => (id === USDC_CONTRACT ? USDC_ASSET : XLM_ASSET),
      pageSize: 20,
      decoder: decode,
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe("pagination past one page", () => {
  it("keeps returning older rows across pages with no overlap", () => {
    // Walks a two-page history the way the dashboard does, so the "tested past
    // one page" requirement is exercised as behaviour, not just a cursor unit
    // test (docs/security-audit.md L6: pagination must not re-scroll or stop).
    const page = (n: number, pageSize: number) => ({
      events: Array.from({ length: pageSize }, (_, i) =>
        liveEvent(USDC_EVENT, {
          id: `page${n}-row${i}`,
          ledgerClosedAt: new Date(Date.UTC(2026, 8, 27, 0, n * pageSize + i)).toISOString(),
        }),
      ),
    });

    const collect = (pages: number, pageSize: number) => {
      const seen: string[] = [];
      for (let p = 0; p < pages; p++) {
        const { rows } = mergeHistoryPages({
          accountId: USDC_EVENT.to,
          events: page(p, pageSize).events,
          ops: [],
          assetOf: () => USDC_ASSET,
          pageSize,
          decoder: decode,
        });
        seen.push(...rows.map((r) => r.id));
      }
      return seen;
    };

    const ids = collect(3, 5);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
  });
});

// --- Cursor packing ----------------------------------------------------------

describe("cursor packing", () => {
  it("round-trips both rail cursors", () => {
    expect(decodePageCursor(encodePageCursor("events-token", "ops-token"))).toEqual({
      events: "events-token",
      ops: "ops-token",
    });
  });

  it("round-trips a single rail", () => {
    expect(decodePageCursor(encodePageCursor(undefined, "ops-only"))).toEqual({ ops: "ops-only" });
    expect(decodePageCursor(encodePageCursor("events-only", undefined))).toEqual({
      events: "events-only",
    });
  });

  it("is undefined only when both rails are exhausted", () => {
    expect(encodePageCursor(undefined, undefined)).toBeUndefined();
    expect(decodePageCursor(undefined)).toBeUndefined();
  });

  it("produces a URL-safe cursor (no +, / or = padding)", () => {
    // Real getEvents/Horizon paging tokens contain characters that break a
    // naive base64 round trip through a query string.
    const cursor = encodePageCursor("0021080979389022208-0000000017/abc+def==", "21115403551948801")!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePageCursor(cursor)).toEqual({
      events: "0021080979389022208-0000000017/abc+def==",
      ops: "21115403551948801",
    });
  });

  it("survives garbage input", () => {
    expect(decodePageCursor("not-a-cursor!")).toBeUndefined();
  });
});

// --- Transient RPC failures ---------------------------------------------------

describe("withTransientRetry", () => {
  it("retries the documented stale-view codes and succeeds", async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("txNoAccount: some stale view");
        return "ok";
      },
      { retries: 4, baseDelayMs: 1, sleep: () => Promise.resolve() },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("covers every documented transient code", async () => {
    for (const code of ["txNoAccount", "txBadSeq", "MissingValue"]) {
      let calls = 0;
      await withTransientRetry(
        async () => {
          calls += 1;
          if (calls < 2) throw new Error(`request failed: ${code}`);
          return true;
        },
        { retries: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
      );
      expect(calls).toBe(2);
    }
  });

  it("retries the live ledger-range rejection from the load balancer", async () => {
    // Observed verbatim against the public testnet RPC.
    let calls = 0;
    const value = await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("startLedger must be within the ledger range: 4795309 - 4916268");
        return 1;
      },
      { retries: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
    );
    expect(value).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not retry a permanent error", async () => {
    let calls = 0;
    await expect(
      withTransientRetry(
        async () => {
          calls += 1;
          throw new Error("connection refused");
        },
        { retries: 4, baseDelayMs: 1, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow("connection refused");
    expect(calls).toBe(1);
  });

  it("rethrows the mapped error once attempts are exhausted", async () => {
    await expect(
      withTransientRetry(
        async () => {
          throw new Error("txBadSeq");
        },
        { retries: 2, baseDelayMs: 1, sleep: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(TransientHistoryError);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withTransientRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error("MissingValue");
        return true;
      },
      {
        retries: 4,
        baseDelayMs: 100,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(delays).toEqual([100, 200, 400]);
  });
});

describe("mapTransientRpcError", () => {
  it("maps known codes to TransientHistoryError", () => {
    expect(mapTransientRpcError(new Error("boom: txNoAccount"))).toBeInstanceOf(TransientHistoryError);
    expect(mapTransientRpcError("plain MissingValue string")).toBeInstanceOf(TransientHistoryError);
  });

  it("passes unknown errors through untouched", () => {
    const err = new Error("unexpected");
    expect(mapTransientRpcError(err)).toBe(err);
  });
});

describe("buildSorobanRail", () => {
  // The rail is fed a whole ledger window in the order getEvents returned it:
  // ASCENDING, oldest first, newest last. Rendering newest-first means
  // reversing, and NOTHING may be trimmed off the tail — the client resumes
  // from the window's oldest ledger, so a trimmed row would have no way to
  // reach the next page. Both were real defects; these pin the fix.
  const assetOf = (id: string) =>
    id === USDC_CONTRACT ? USDC_ASSET : id === XLM_CONTRACT ? XLM_ASSET : undefined;

  it("reverses the ascending stream so the newest transfer is first", () => {
    const events = [
      liveEvent(USDC_EVENT, { id: "ev-1", ledger: 10 }),
      liveEvent(XLM_EVENT, { id: "ev-2", ledger: 11 }),
    ];
    const rows = buildSorobanRail({ accountId: ACCOUNT, events, assetOf, decoder: decode });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([
      `soroban:${XLM_CONTRACT}:ev-2`,
      `soroban:${USDC_CONTRACT}:ev-1`,
    ]);
  });

  it("keeps every transfer in the window, even well past a page size", () => {
    // No pageSize is passed at all: the builder must not trim. Trimming was
    // what made trimmed rows unreachable on the next page.
    const events = Array.from({ length: 250 }, (_, i) =>
      liveEvent(USDC_EVENT, { id: `ev-${i}`, ledger: 100 + i }),
    );
    const rows = buildSorobanRail({ accountId: ACCOUNT, events, assetOf, decoder: decode });

    expect(rows).toHaveLength(250);
    expect(rows[0]?.id).toBe(`soroban:${USDC_CONTRACT}:ev-249`);
    expect(rows.at(-1)?.id).toBe(`soroban:${USDC_CONTRACT}:ev-0`);
  });

  it("drops non-transfer events and unresolvable assets, never rendering a bare amount", () => {
    const events = [
      liveEvent(USDC_EVENT, { id: "keep", ledger: 10 }),
      // A `fee` event: right contract, wrong topic count.
      liveEvent(USDC_EVENT, { id: "fee", ledger: 11, topic: [USDC_EVENT.topicBase64[0]] }),
      // A transfer from a contract whose metadata cannot be resolved.
      liveEvent(XLM_EVENT, { id: "unknown-asset", ledger: 12 }),
    ];
    const rows = buildSorobanRail({
      accountId: ACCOUNT,
      events,
      assetOf: () => undefined,
      decoder: decode,
    });
    expect(rows).toEqual([]);

    // With assets resolved the two real transfers survive; the `fee` event
    // is still excluded, because it carries only one topic.
    const kept = buildSorobanRail({
      accountId: ACCOUNT,
      events,
      assetOf,
      decoder: decode,
    });
    expect(kept.map((r) => r.id)).toEqual([
      `soroban:${XLM_CONTRACT}:unknown-asset`,
      `soroban:${USDC_CONTRACT}:keep`,
    ]);
  });

  it("returns nothing for an empty window rather than throwing", () => {
    expect(buildSorobanRail({ accountId: ACCOUNT, events: [], assetOf, decoder: decode })).toEqual(
      [],
    );
  });
});

describe("buildClassicRail", () => {
  // Horizon is queried order("desc"), so ops arrive newest-first and the rail
  // CAN express a lossless resume point — which is why this rail still trims
  // and the Soroban rail does not.
  it("keeps a full page and reports no resume when nothing was trimmed", () => {
    const ops = Array.from({ length: 3 }, (_, i) =>
      classicPayment({ id: `op-${i}`, paging_token: `token-${i}` }),
    );
    const page = buildClassicRail({ accountId: ACCOUNT, ops, pageSize: 5 });

    expect(page.rows).toHaveLength(3);
    expect(page.resume).toBeUndefined();
  });

  it("resumes at the paging token of the last EMITTED row, not the last record", () => {
    // op-1 is not a payment, so classicOpToRow drops it. Resuming at its token
    // would silently skip the payment that follows it.
    const ops = [
      classicPayment({ id: "op-0", paging_token: "token-0" }),
      classicPayment({ id: "op-1", paging_token: "token-1", type: "create_account" }),
      classicPayment({ id: "op-2", paging_token: "token-2" }),
      classicPayment({ id: "op-3", paging_token: "token-3" }),
    ];
    const page = buildClassicRail({ accountId: ACCOUNT, ops, pageSize: 2 });

    expect(page.rows.map((r) => r.id)).toEqual(["classic:op-0", "classic:op-2"]);
    expect(page.resume).toBe("token-2");
  });
});
