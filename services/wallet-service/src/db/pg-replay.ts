import { and, eq, lt, or } from "drizzle-orm";
import type { BudgetNetwork } from "@vellar/service-kit";
import type { ReplayGuard, ReplayKey } from "../replay";
import type { Db } from "./client";
import { submissionReplay } from "./schema";

// Postgres replay guard (approved design 1A). See src/replay.ts for the replay
// model: identity is (server-config network, credential address, nonce) per auth
// entry, reserved all-or-nothing before the submitter runs.
//
// ATOMICITY. A single multi-row INSERT ... ON CONFLICT DO NOTHING inside one
// transaction: if fewer rows were inserted than keys were requested, at least one
// key was already reserved, so the transaction is rolled back and NONE of the
// set stays reserved (a partial replay must not lock out its legitimate
// entries). The primary key is the arbiter, so concurrent copies on any replica
// cannot both succeed: the loser waits for the winner's commit, then conflicts.
//
// DEADLOCK AVOIDANCE. Two overlapping sets inserted in opposite orders (AB / BA)
// would otherwise wait on each other's uncommitted rows. Keys are inserted in a
// canonical (address, nonce) order, so every transaction takes locks in the same
// order.

class ReplayConflict extends Error {
  constructor() {
    super("replay: at least one auth entry was already reserved");
    this.name = "ReplayConflict";
  }
}

function canonicalOrder(keys: ReplayKey[]): ReplayKey[] {
  return [...keys].sort((a, b) =>
    a.address === b.address
      ? a.nonce < b.nonce
        ? -1
        : a.nonce > b.nonce
          ? 1
          : 0
      : a.address < b.address
        ? -1
        : 1,
  );
}

export function createPgReplayGuard(db: Db, network: BudgetNetwork): ReplayGuard {
  return {
    async reserve(keys) {
      if (keys.length === 0) return { ok: true };
      const ordered = canonicalOrder(keys);
      try {
        await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(submissionReplay)
            .values(
              ordered.map((k) => ({
                network,
                address: k.address,
                nonce: k.nonce,
                expirationLedger: k.signatureExpirationLedger,
              })),
            )
            .onConflictDoNothing()
            .returning({ nonce: submissionReplay.nonce });
          if (inserted.length !== ordered.length) throw new ReplayConflict();
        });
      } catch (err) {
        if (err instanceof ReplayConflict) return { ok: false, reason: "replay" };
        throw err; // storage failure: the caller refuses (fails closed)
      }
      return { ok: true };
    },

    async release(keys) {
      if (keys.length === 0) return;
      await db
        .delete(submissionReplay)
        .where(
          and(
            eq(submissionReplay.network, network),
            or(
              ...keys.map((k) =>
                and(eq(submissionReplay.address, k.address), eq(submissionReplay.nonce, k.nonce)),
              ),
            ),
          ),
        );
    },

    async purgeExpired(currentLedger) {
      await db
        .delete(submissionReplay)
        .where(
          and(
            eq(submissionReplay.network, network),
            lt(submissionReplay.expirationLedger, currentLedger),
          ),
        );
    },
  };
}
