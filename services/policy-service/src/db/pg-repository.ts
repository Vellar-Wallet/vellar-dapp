import { eq } from "drizzle-orm";
import type { PolicyRecord, PolicyRepository } from "../server";
import type { Db } from "./client";
import { policies } from "./schema";

// Postgres implementation of the policy persistence seam. Shape and semantics
// must match createMemoryPolicyRepository exactly — the route tests define the
// contract. The whole record is stored as jsonb; id/status/createdAt are
// mirrored into scalar columns for inspection.
export function createPgPolicyRepository(db: Db): PolicyRepository {
  return {
    async insert(record) {
      await db.insert(policies).values(toRow(record));
    },

    async find(id) {
      const rows = await db.select().from(policies).where(eq(policies.id, id)).limit(1);
      return rows[0]?.record;
    },

    async update(record) {
      await db
        .update(policies)
        .set({ status: record.status, record })
        .where(eq(policies.id, record.id));
    },
  };
}

function toRow(record: PolicyRecord) {
  return {
    id: record.id,
    status: record.status,
    createdAt: new Date(record.createdAt),
    record,
  };
}
