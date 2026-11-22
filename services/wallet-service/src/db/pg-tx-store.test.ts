/**
 * Race-focused unit tests for the processed-message store (issue #788).
 *
 * The store's exactly-once guarantee rests on two properties: the insert is
 * conflict-tolerant (INSERT ... ON CONFLICT DO NOTHING) and the status read
 * sees only committed rows. The fake Db below models those properties without
 * requiring Postgres, so these tests run locally and in CI. It deliberately
 * throws if a duplicate insert is attempted without onConflictDoNothing(),
 * mirroring the primary-key violation a real database would raise.
 */

import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { checkTransactionStatus, markInFlight, markProcessed } from "./pg-tx-store";
import { transactionSubmissions } from "./schema";

const TX_ID = "tx-race-0001";
const SIGNED_XDR = "AAAAAAAAAAAAAAAAAAAA";
const NETWORK = "testnet";

type StoredRow = {
  transactionId: string;
  status: string;
  record: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
};

/** Compare a Drizzle WHERE expression to the filter for a known transaction id. */
function isTransactionFilter(expression: unknown, transactionId: string): boolean {
  return isDeepStrictEqual(expression, eq(transactionSubmissions.transactionId, transactionId));
}

function createFakeDb() {
  const rows = new Map<string, StoredRow>();
  let writeGate: Promise<void> | null = null;

  function findRow(expression: unknown): StoredRow | undefined {
    if (rows.size === 0) return undefined;
    const id = [...rows.keys()].find((key) => isTransactionFilter(expression, key));
    if (!id) throw new Error("fake Db: WHERE clause was not a transaction-id equality filter");
    return rows.get(id);
  }

  const db = {
    select(projection?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          if (table !== transactionSubmissions) throw new Error("fake Db: unexpected table");
          return this;
        },
        where(expression: unknown) {
          const row = findRow(expression);
          if (!row) return Promise.resolve([]);
          if (!projection) return Promise.resolve([{ ...row, record: { ...row.record } }]);
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(projection)) {
            projected[key] = (row as unknown as Record<string, unknown>)[key];
          }
          return Promise.resolve([projected]);
        },
      };
    },
    insert(table: unknown) {
      if (table !== transactionSubmissions) throw new Error("fake Db: unexpected table");
      let values: StoredRow;
      let conflictTolerant = false;
      return {
        values(next: StoredRow) {
          values = next;
          return this;
        },
        onConflictDoNothing() {
          conflictTolerant = true;
          return this;
        },
        async returning() {
          if (writeGate) {
            const gate = writeGate;
            writeGate = null;
            await gate;
          }
          if (!conflictTolerant) {
            throw new Error("fake Db: duplicate insert without onConflictDoNothing");
          }
          if (rows.has(values.transactionId)) return [];
          const row: StoredRow = { ...values, record: { ...values.record } };
          rows.set(values.transactionId, row);
          return [{ ...row, record: { ...row.record } }];
        },
      };
    },
    update(table: unknown) {
      if (table !== transactionSubmissions) throw new Error("fake Db: unexpected table");
      let patch: Record<string, unknown>;
      return {
        set(next: Record<string, unknown>) {
          patch = next;
          return this;
        },
        where(expression: unknown) {
          const row = findRow(expression);
          if (row) {
            const previousRecord = row.record;
            Object.assign(row, patch);
            // markProcessed passes the column reference to preserve the JSONB blob.
            if (patch.record === transactionSubmissions.record) row.record = previousRecord;
          }
          return Promise.resolve({ rowCount: row ? 1 : 0 });
        },
      };
    },
  };

  return {
    db: db as unknown as Db,
    getRow: (transactionId: string) => rows.get(transactionId),
    /** Hold the next insert open so a read can be interleaved before it commits. */
    armWriteGate() {
      let release!: () => void;
      writeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

describe("transaction store write/read race (issue #788)", () => {
  let fixture: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    fixture = createFakeDb();
  });

  it("writes then reads the same record with the documented in-flight and processed TTLs", async () => {
    expect(await checkTransactionStatus(fixture.db, TX_ID)).toBeNull();

    expect(await markInFlight(fixture.db, TX_ID, "worker-a", SIGNED_XDR, NETWORK, "relayer")).toBe(
      true,
    );
    expect(await checkTransactionStatus(fixture.db, TX_ID)).toBe("processing");

    const inFlight = fixture.getRow(TX_ID)!;
    expect(inFlight.record).toMatchObject({
      transactionId: TX_ID,
      signedXdr: SIGNED_XDR,
      network: NETWORK,
      workerId: "worker-a",
      attempts: 1,
    });
    expect(inFlight.expiresAt!.getTime() - inFlight.createdAt.getTime()).toBe(5 * 60 * 1000);

    await markProcessed(fixture.db, TX_ID, "stellar-hash-0001");
    const processed = fixture.getRow(TX_ID)!;
    expect(await checkTransactionStatus(fixture.db, TX_ID)).toBe("succeeded");
    expect(processed.record).toMatchObject({ workerId: "worker-a", signedXdr: SIGNED_XDR });
    expect(processed.expiresAt!.getTime() - processed.updatedAt.getTime()).toBe(
      48 * 60 * 60 * 1000,
    );
  });

  it("a read concurrent with the write observes only committed state", async () => {
    const releaseWrite = fixture.armWriteGate();

    const write = markInFlight(fixture.db, TX_ID, "worker-a", SIGNED_XDR, NETWORK, "relayer");
    const statusDuringWrite = await checkTransactionStatus(fixture.db, TX_ID);
    releaseWrite();
    await write;

    expect(statusDuringWrite).toBeNull();
    expect(await checkTransactionStatus(fixture.db, TX_ID)).toBe("processing");
    expect(fixture.getRow(TX_ID)!.record).toMatchObject({ workerId: "worker-a" });
  });

  it("a second writer racing the same id loses the conflict without overwriting the winner", async () => {
    expect(await markInFlight(fixture.db, TX_ID, "worker-a", SIGNED_XDR, NETWORK, "relayer")).toBe(
      true,
    );
    expect(
      await markInFlight(fixture.db, TX_ID, "worker-b", "other-xdr", "pubnet", "sponsor"),
    ).toBe(false);

    expect(fixture.getRow(TX_ID)!.record).toMatchObject({
      workerId: "worker-a",
      signedXdr: SIGNED_XDR,
      network: NETWORK,
    });
    expect(await checkTransactionStatus(fixture.db, TX_ID)).toBe("processing");
  });
});
