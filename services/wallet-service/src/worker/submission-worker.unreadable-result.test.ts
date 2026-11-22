/**
 * Unreadable-result regression test for issue #787.
 *
 * A transaction can succeed on-chain while the worker cannot read the result
 * back (SDK version mismatch, unexpected result type). The worker must treat
 * that as success, record the transaction id as the hash fallback, and never
 * mark it failed or resubmit it on redelivery. Store calls are mocked so the
 * assertions target the worker's outcome handling, not the database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";

const {
  checkStatusMock,
  markInFlightMock,
  markProcessedMock,
  markFailedMock,
  clearLockMock,
  cleanupMock,
} = vi.hoisted(() => ({
  checkStatusMock: vi.fn(),
  markInFlightMock: vi.fn(),
  markProcessedMock: vi.fn(),
  markFailedMock: vi.fn(),
  clearLockMock: vi.fn(),
  cleanupMock: vi.fn(),
}));

vi.mock("../db/pg-tx-store", async () => {
  const actual = await vi.importActual<typeof import("../db/pg-tx-store")>("../db/pg-tx-store");
  return {
    ...actual,
    checkTransactionStatus: checkStatusMock,
    markInFlight: markInFlightMock,
    markProcessed: markProcessedMock,
    markFailed: markFailedMock,
    clearInFlightLock: clearLockMock,
    cleanupExpiredRecords: cleanupMock,
  };
});

import { runSubmissionWorkerTick } from "./submission-worker";

const TX_ID = "tx-unreadable-result-0001";
const SIGNED_XDR = "AAAAAAAAAAAAAAAAAAAA";

function createClaimDb(): Db {
  const db = {
    select() {
      return {
        from() {
          return this;
        },
        where() {
          return this;
        },
        limit(size: number) {
          return Promise.resolve(
            [
              {
                transactionId: TX_ID,
                status: "submitted",
                record: {
                  signedXdr: SIGNED_XDR,
                  network: "testnet",
                  submitterType: "relayer",
                  attempts: 1,
                },
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ].slice(0, size),
          );
        },
      };
    },
  };
  return db as unknown as Db;
}

describe("submission worker with an unreadable result (issue #787)", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Keep the 10% cleanup branch out of these assertions.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    checkStatusMock.mockResolvedValue(null);
    markInFlightMock.mockResolvedValue(true);
    cleanupMock.mockResolvedValue(0);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  // A missing hash exercises the worker's tx-id fallback. A present but
  // unparseable hash is still a successful submit: the worker records the
  // value it was given, but must not mark the transaction failed or resubmit.
  it.each([
    ["an absent hash", undefined, TX_ID],
    ["a garbled hash", "not-a-stellar-hash", "not-a-stellar-hash"],
  ])("records success when the submitter returns %s", async (_label, hash, expectedHash) => {
    const submit = vi.fn().mockResolvedValue({ hash });
    const metrics = {
      submissionResult: vi.fn(),
      workerFailure: vi.fn(),
    };
    const deps = {
      db: createClaimDb(),
      submitter: { submit },
      metrics,
      workerId: "test-worker",
      log: { info: vi.fn(), error: vi.fn() },
    };

    expect(await runSubmissionWorkerTick(deps)).toBe(1);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(SIGNED_XDR);
    expect(markProcessedMock).toHaveBeenCalledTimes(1);
    expect(markProcessedMock).toHaveBeenCalledWith(deps.db, TX_ID, expectedHash);
    expect(markFailedMock).not.toHaveBeenCalled();
    expect(clearLockMock).not.toHaveBeenCalled();
    expect(metrics.submissionResult).toHaveBeenCalledTimes(1);
    expect(metrics.submissionResult).toHaveBeenCalledWith("succeeded", expect.any(Number));
    expect(metrics.workerFailure).not.toHaveBeenCalled();

    // Redelivery after the success record is visible must not submit again.
    checkStatusMock.mockResolvedValue("succeeded");
    expect(await runSubmissionWorkerTick(deps)).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(markProcessedMock).toHaveBeenCalledTimes(1);
  });
});
