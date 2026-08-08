import { randomUUID } from "node:crypto";
import type { SpendBudget, BudgetLimits, ConsumeRequest, ConsumeResult } from "@vellar/service-kit";
import type { Db } from "./client";
import { sql } from "drizzle-orm";

// Postgres-backed rolling-window spend budget (security-audit.md H1/M2/FIX 3).
//
// The check and the record are a SINGLE atomic statement: a CTE aggregates the
// window for (line, network), and the INSERT ... SELECT only produces a row
// when adding this call stays within BOTH ceilings. Because the aggregate and
// the insert are one statement under READ COMMITTED, two concurrent requests
// cannot both observe "room for one more" and both insert past the ceiling —
// the second sees the first's committed row (or, if truly simultaneous, the
// window sum reflects it). We verify this with a concurrency integration test.
//
// Keyed off the network the CALLER passes (from server config, never a request
// body — V5). Fails by throwing on a DB error; callers treat any throw as
// "refuse" (fail closed).

export interface BudgetConfig {
  windowMs: number;
  limits: Record<ConsumeRequest["line"], BudgetLimits>;
  now?: () => Date;
}

export function createPgSpendBudget(db: Db, config: BudgetConfig): SpendBudget {
  const now = config.now ?? (() => new Date());

  return {
    async tryConsume(req: ConsumeRequest): Promise<ConsumeResult> {
      const limits = config.limits[req.line];
      const addCount = req.count ?? 1;
      const windowStart = new Date(now().getTime() - config.windowMs);
      const id = randomUUID();
      const at = now();
      // maxStroops omitted => count-only line: an effectively unbounded XLM
      // ceiling so only the count dimension gates.
      const maxStroops = limits.maxStroops ?? null;

      // INSERT only if within ceiling. The `agg` CTE sums the current window;
      // the guarded INSERT ... SELECT ... WHERE emits a row solely when both
      // dimensions still fit. RETURNING tells us whether it landed.
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

      // node-postgres returns { rows }; some drivers return the array directly.
      const rows = (result as unknown as { rows?: unknown[] }).rows;
      const inserted = Array.isArray(rows) ? rows : Array.isArray(result) ? result : [];
      return inserted.length > 0 ? { ok: true } : { ok: false, reason: "budget_exceeded" };
    },
  };
}
