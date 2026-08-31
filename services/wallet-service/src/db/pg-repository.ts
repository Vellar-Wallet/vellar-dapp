import { and, desc, eq, gt } from "drizzle-orm";
import type { Network } from "@vellar/types";
import {
  DuplicateWalletError,
  type AuditLog,
  type SessionRepository,
  type WalletRepository,
} from "../repository";
import type { Db } from "./client";
import { activityLogs, wallets, walletSessions } from "./schema";

// Postgres implementations of the wallet-service persistence seams. Shapes
// and error semantics must match the in-memory implementations exactly —
// the route tests define the contract.

export function createPgWalletRepository(db: Db): WalletRepository {
  return {
    async insert(record) {
      const inserted = await db
        .insert(wallets)
        .values({
          keyId: record.keyId,
          contractId: record.contractId,
          network: record.network,
          createdAt: new Date(record.createdAt),
        })
        .onConflictDoNothing()
        .returning({ keyId: wallets.keyId });
      if (inserted.length === 0) {
        throw new DuplicateWalletError(record.keyId, record.network);
      }
    },

    async findByKeyId(keyId, network) {
      const rows = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.keyId, keyId), eq(wallets.network, network)))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        keyId: row.keyId,
        contractId: row.contractId,
        network: row.network as Network,
        createdAt: row.createdAt.toISOString(),
      };
    },

    async existsByContractId(contractId, network) {
      const rows = await db
        .select({ keyId: wallets.keyId })
        .from(wallets)
        .where(and(eq(wallets.contractId, contractId), eq(wallets.network, network)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export function createPgSessionRepository(db: Db): SessionRepository {
  return {
    async insert(record) {
      await db.insert(walletSessions).values({
        id: record.id,
        contractId: record.contractId,
        network: record.network,
        createdAt: new Date(record.createdAt),
        lastActiveAt: new Date(record.lastActiveAt),
        expiresAt: new Date(record.expiresAt),
      });
    },

    async find(id, asOf = new Date()) {
      // Expired rows are ABSENT: filter on expiresAt in the query, so an expired
      // id is indistinguishable from a missing one (no "was once valid" signal).
      const rows = await db
        .select()
        .from(walletSessions)
        .where(and(eq(walletSessions.id, id), gt(walletSessions.expiresAt, asOf)))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return toSessionRecord(row);
    },

    async listByContract(contractId, network, asOf = new Date()) {
      const rows = await db
        .select()
        .from(walletSessions)
        .where(
          and(
            eq(walletSessions.contractId, contractId),
            eq(walletSessions.network, network),
            gt(walletSessions.expiresAt, asOf),
          ),
        )
        .orderBy(desc(walletSessions.lastActiveAt));
      return rows.map(toSessionRecord);
    },

    async touch(id, at, newExpiresAt) {
      // Only a currently-live row slides forward — a rejected/expired id (past
      // expiresAt) matches nothing and cannot extend its own life.
      const updated = await db
        .update(walletSessions)
        .set({ lastActiveAt: at, expiresAt: newExpiresAt })
        .where(and(eq(walletSessions.id, id), gt(walletSessions.expiresAt, at)))
        .returning({ id: walletSessions.id });
      return updated.length > 0;
    },

    async delete(id) {
      const deleted = await db
        .delete(walletSessions)
        .where(eq(walletSessions.id, id))
        .returning({ id: walletSessions.id });
      return deleted.length > 0;
    },
  };
}

function toSessionRecord(row: typeof walletSessions.$inferSelect) {
  return {
    id: row.id,
    contractId: row.contractId,
    network: row.network as Network,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function createPgAuditLog(db: Db): AuditLog {
  return {
    async record(type, data, actor) {
      await db.insert(activityLogs).values({
        id: crypto.randomUUID(),
        type,
        at: new Date(),
        data: { ...data, ...(actor ? { actor } : {}) },
      });
    },

    async list(filter) {
      const rows = await db.select().from(activityLogs).orderBy(activityLogs.at);
      let events = rows.map((row) => ({
        type: row.type,
        at: row.at.toISOString(),
        data: row.data,
        actor: (row.data as Record<string, unknown> | undefined)?.actor as string | undefined,
      }));
      if (filter?.type) {
        events = events.filter((e) => e.type === filter.type);
      }
      if (filter?.actor) {
        events = events.filter((e) => e.actor === filter.actor);
      }
      return events;
    },
  };
}
