// Rolling-window spend budgets for the sponsor/relayer funding paths
// (security-audit.md H1/M2/FIX 3). The gateway per-IP rate limit does not bind
// (no trustProxy — req.ip is the platform ingress), so this SPEND cap is the
// control that actually bounds funding-path abuse.
//
// Design invariants:
//  - Keyed off SERVER CONFIG only (network passed by the caller from config),
//    never a request body's network field (V5).
//  - FAIL CLOSED: if the ledger cannot be accounted (no DB / DB down), refuse —
//    never sponsor unmetered. createUnavailableBudget is that refusing stub.
//  - Check + record are ONE atomic statement in the Postgres impl (see
//    pg-budget), so two concurrent requests cannot both pass before either
//    records.

export type BudgetLine = "sponsor" | "deploy" | "create";
export type BudgetNetwork = "testnet" | "mainnet";

export interface BudgetLimits {
  /** XLM ceiling in stroops for the rolling window. Omit for a count-only line
   * (e.g. relayer-funded create, where spend isn't measured in server-held XLM). */
  maxStroops?: bigint;
  /** Call-count ceiling for the rolling window. */
  maxCount: number;
}

export interface ConsumeRequest {
  line: BudgetLine;
  network: BudgetNetwork;
  /** Stroops this call would spend (0 for a count-only line). */
  stroops: bigint;
  /** Calls to record (default 1). */
  count?: number;
}

export type ConsumeResult = { ok: true } | { ok: false; reason: string };

export interface SpendBudget {
  /** Atomically: if adding this call stays within the line's rolling-window
   * ceiling, record it and return ok; otherwise refuse. */
  tryConsume(req: ConsumeRequest): Promise<ConsumeResult>;
}

/** Pure ceiling check: would (prior + this) stay within limits? The tighter
 * dimension trips first. XLM is ignored when the line has no maxStroops. */
export function withinCeiling(
  prior: { priorStroops: bigint; priorCount: number },
  addStroops: bigint,
  limits: BudgetLimits,
): boolean {
  if (prior.priorCount + 1 > limits.maxCount) return false;
  if (limits.maxStroops !== undefined && prior.priorStroops + addStroops > limits.maxStroops) {
    return false;
  }
  return true;
}

/** A budget that always refuses — used when persistence is unavailable so the
 * funding paths fail closed instead of spending unmetered (Q2 / FIX 7). */
export function createUnavailableBudget(): SpendBudget {
  return {
    async tryConsume() {
      return { ok: false, reason: "budget_unavailable" };
    },
  };
}

const XLM_STROOPS = 10_000_000n;

/** Build a line's limits from env, converting the XLM var to stroops. */
export function budgetLimitsFromEnv(
  vars: { maxXlmVar?: string; maxCountVar: string },
  defaults: { defaultMaxXlm?: number; defaultMaxCount: number },
  env: Record<string, string | undefined> = process.env,
): BudgetLimits {
  const count = env[vars.maxCountVar];
  const maxCount = count ? Number(count) : defaults.defaultMaxCount;

  if (!vars.maxXlmVar && defaults.defaultMaxXlm === undefined) {
    return { maxCount };
  }
  const xlmRaw = vars.maxXlmVar ? env[vars.maxXlmVar] : undefined;
  const maxXlm = xlmRaw !== undefined ? Number(xlmRaw) : defaults.defaultMaxXlm;
  if (maxXlm === undefined) return { maxCount };
  return { maxStroops: BigInt(Math.round(maxXlm)) * XLM_STROOPS, maxCount };
}
