import { desc, eq } from "drizzle-orm";
import type { VerificationRepository, VerificationRecordInternal } from "../server";
import type { Db } from "./client";
import { verificationRecords } from "./schema";

// Postgres implementation of the verification persistence seam. Shape and
// semantics must match createMemoryVerificationRepository exactly — the route
// tests define the contract. The whole record is stored as jsonb; scalar
// columns mirror the fields used for lookup/sort/claim.
export function createPgVerificationRepository(db: Db): VerificationRepository {
  return {
    async insert(record) {
      await db.insert(verificationRecords).values(toRow(record));
    },

    async find(id) {
      const rows = await db
        .select()
        .from(verificationRecords)
        .where(eq(verificationRecords.id, id))
        .limit(1);
      return rows[0]?.record;
    },

    async findByContract(contractId) {
      const rows = await db
        .select()
        .from(verificationRecords)
        .where(eq(verificationRecords.contractId, contractId))
        .orderBy(desc(verificationRecords.createdAt));
      return rows.map((r) => r.record);
    },

    async update(record) {
      await db
        .update(verificationRecords)
        .set({
          status: record.status,
          updatedAt: new Date(record.updatedAt),
          record,
        })
        .where(eq(verificationRecords.id, record.id));
    },
  };
}

function toRow(record: VerificationRecordInternal) {
  return {
    id: record.id,
    contractId: record.contractId,
    status: record.status,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    record,
  };
}
