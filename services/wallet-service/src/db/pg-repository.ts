import { and, desc, eq } from "drizzle-orm";
import type { Network } from "@vela/types";
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
      });
    },

    async find(id) {
      const rows = await db.select().from(walletSessions).where(eq(walletSessions.id, id)).limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return toSessionRecord(row);
    },

    async listByContract(contractId, network) {
      const rows = await db
        .select()
        .from(walletSessions)
        .where(and(eq(walletSessions.contractId, contractId), eq(walletSessions.network, network)))
        .orderBy(desc(walletSessions.lastActiveAt));
      return rows.map(toSessionRecord);
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
  };
}

export function createPgAuditLog(db: Db): AuditLog {
  return {
    async record(type, data) {
      await db.insert(activityLogs).values({
        id: crypto.randomUUID(),
        type,
        at: new Date(),
        data,
      });
    },

    async list() {
      const rows = await db.select().from(activityLogs).orderBy(activityLogs.at);
      return rows.map((row) => ({
        type: row.type,
        at: row.at.toISOString(),
        data: row.data,
      }));
    },
  };
}
