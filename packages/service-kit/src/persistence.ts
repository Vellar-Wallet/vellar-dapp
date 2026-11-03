// Persistence boot policy (security-audit.md M6 / FIX 7; inverted per RA-4).
//
// The old behavior silently degraded to in-memory repositories whenever
// DATABASE_URL was unset OR Postgres was unreachable, and /health still
// reported "ok" — so a misconfigured production instance served traffic on
// volatile state (audit log, session list, and — since FIX 1/FIX 3 — the
// funding-path scoping and spend budgets all depend on durable state).
//
// FIX 7 gated fail-closed on `NODE_ENV === "production"`. RA-4: NOTHING sets
// NODE_ENV=production on the deploy targets (@vellar/all-in-one runs via
// `tsx src/index.ts`; no railway.json/.env sets it), so that guard
// was inert and the instance silently degraded — fail-OPEN by default. A missing
// env var meant "not production" meant "less safe."
//
// INVERTED: the default is FAIL-CLOSED. In-memory is the less-safe branch, so it
// requires an EXPLICIT signal — either ALLOW_INMEMORY=1 (operator opt-in) or an
// explicitly non-production NODE_ENV (`development`/`test`). An UNSET NODE_ENV —
// the deploy-target reality — no longer degrades; it refuses to boot without a
// durable DB. Local dev keeps working (tsx watch/Next set development; Vitest
// sets test; or set ALLOW_INMEMORY=1).

export interface PersistenceInputs {
  /** process.env.DATABASE_URL (undefined when unset). */
  databaseUrl: string | undefined;
  /** process.env.NODE_ENV. UNSET is treated as a deployed environment (fail
   * closed) — NOT as dev. */
  nodeEnv: string | undefined;
  /** Whether a connection attempt succeeded. Omit when no attempt was made
   * (i.e. databaseUrl is unset). */
  connected?: boolean;
  /** process.env.ALLOW_INMEMORY === "1" — explicit operator opt-in to run
   * stateless (e.g. an ephemeral demo), honored in ANY environment. */
  allowInmemory?: boolean;
}

export type PersistenceDecision =
  { action: "use-postgres" } | { action: "allow-inmemory" } | { action: "fail"; reason: string };

/** In-memory is permitted ONLY on an explicitly non-production environment.
 * Crucially, an UNSET NODE_ENV is NOT ephemeral — it fails closed. This is the
 * RA-4 inversion: absence means "assume deployed," not "assume dev." */
const isExplicitlyEphemeral = (nodeEnv: string | undefined) =>
  nodeEnv === "development" || nodeEnv === "test";

/** Decide how a service should handle its persistence at boot. Pure so the
 * fail-closed logic is unit-tested without spinning a real DB. */
export function resolvePersistencePolicy(inputs: PersistenceInputs): PersistenceDecision {
  const { databaseUrl, nodeEnv, connected, allowInmemory } = inputs;

  // Explicit opt-in always wins: an operator who sets ALLOW_INMEMORY=1 has
  // accepted volatile state, in any environment.
  if (allowInmemory) return { action: "allow-inmemory" };

  // A durable, connected DB is always fine.
  if (databaseUrl && connected) return { action: "use-postgres" };

  // No usable durable store. Degrade ONLY on an explicitly ephemeral env;
  // otherwise (incl. NODE_ENV unset — the deploy-target reality) fail closed.
  if (isExplicitlyEphemeral(nodeEnv)) return { action: "allow-inmemory" };

  if (!databaseUrl) {
    return {
      action: "fail",
      reason:
        "DATABASE_URL is not set and this is not an explicitly ephemeral environment " +
        "(NODE_ENV is not development/test). Refusing to run on volatile in-memory storage. " +
        "Set DATABASE_URL, or ALLOW_INMEMORY=1 to explicitly accept volatile state.",
    };
  }
  return {
    action: "fail",
    reason:
      "DATABASE_URL is set but Postgres is unreachable (could not connect). Refusing to degrade " +
      "to in-memory storage (fail-closed). Fix the database or set ALLOW_INMEMORY=1.",
  };
}
