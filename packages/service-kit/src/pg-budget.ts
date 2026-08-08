import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { BudgetLimits, ConsumeRequest, ConsumeResult, SpendBudget } from "./budget";

// Postgres-backed rolling-window spend budget (security-audit.md H1/M2/FIX 3).
// Shared by every funding-path service (wallet + policy) so the atomic
// conditional-INSERT lives in ONE place. Each service owns its own spend_ledger
// migration; this only needs a drizzle-style executor.
//
// The check and the record are a SINGLE atomic statement: a CTE aggregates the
// window for (line, network), and the INSERT ... SELECT emits a row only when
// adding this call stays within BOTH ceilings. Two concurrent requests cannot
// both pass before either records (verified by a real-Postgres concurrency
// test). Keyed off the network the CALLER passes (server config, never a
// request body — V5). Throws on a DB error; callers treat a throw as "refuse"
// (fail closed).

/** Minimal structural view of a drizzle db — just what the budget needs. */
export interface BudgetDb {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export interface PgBudgetConfig {
  windowMs: number;
  limits: Record<ConsumeRequest["line"], BudgetLimits>;
  now?: () => Date;
}

export function createPgSpendBudget(db: BudgetDb, config: PgBudgetConfig): SpendBudget {
  const now = config.now ?? (() => new Date());

  return {
    async tryConsume(req: ConsumeRequest): Promise<ConsumeResult> {
      const limits = config.limits[req.line];
      const addCount = req.count ?? 1;
      const windowStart = new Date(now().getTime() - config.windowMs);
      const id = randomUUID();
      const at = now();
      const maxStroops = limits.maxStroops ?? null; // null => count-only line

      const result = await db.execute(sql`
        WITH agg AS (
          SELECT
            COALESCE(SUM(stroops), 0)::numeric AS sum_stroops,
            COALESCE(SUM(count), 0)::int      AS sum_count
          FROM spend_ledger
          WHERE line = ${req.line}
            AND network = ${req.network}
            AND at > ${windowStart}
        )
        INSERT INTO spend_ledger (id, line, network, stroops, count, at)
        SELECT ${id}, ${req.line}, ${req.network}, ${req.stroops.toString()}::bigint, ${addCount}, ${at}
        FROM agg
        WHERE agg.sum_count + ${addCount} <= ${limits.maxCount}
          AND (${maxStroops}::numeric IS NULL
               OR agg.sum_stroops + ${req.stroops.toString()}::numeric <= ${maxStroops}::numeric)
        RETURNING id
      `);

      const rows = (result as { rows?: unknown[] }).rows;
      const inserted = Array.isArray(rows) ? rows : Array.isArray(result) ? result : [];
      return inserted.length > 0 ? { ok: true } : { ok: false, reason: "budget_exceeded" };
    },
  };
}
