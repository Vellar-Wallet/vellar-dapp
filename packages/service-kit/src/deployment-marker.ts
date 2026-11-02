import type { DeployEnv } from "./deploy-env";
import { flagIsSet } from "./deploy-env";

// Which tier does THIS DATABASE belong to? (catalogue 1.4, staging tier)
//
// Comparing connection strings only works if the staging process is handed the
// production one, which puts production credentials into staging. Instead each
// database carries a one-row marker, `deployment_marker.deploy_env`, and every
// service checks it right after taking the migration lock, before it migrates or
// reads anything:
//
//   - a database marked 'staging' is refused by a production process, and a database
//     marked 'production' is refused by a staging process (both directions);
//   - production adopts an UNMARKED database as 'production' (insert only, never an
//     update, so an existing deployment gains the marker on its first boot);
//   - staging NEVER adopts silently: an unmarked database is only claimed when the
//     operator sets INIT_DEPLOY_MARKER=1 AND the database is fresh (no tables at all),
//     so a staging stack pointed at some existing database can neither write to it
//     nor take it over;
//   - 'development' (local, throwaway) never writes a marker, but it READS one and refuses a
//     database marked 'production' (a development process must not run on a production stack).
//
// A mismatch is fatal: tryConnectDb rethrows DeploymentMarkerError instead of falling
// back to in-memory storage.

export class DeploymentMarkerError extends Error {
  readonly code = "deployment_marker_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "DeploymentMarkerError";
  }
}

/** The slice of a pg client / pool client this needs. */
export interface MarkerClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

type Tier = "production" | "staging";

const TABLE = "deployment_marker";

async function readMarker(client: MarkerClient): Promise<Tier | undefined | "no-table"> {
  const reg = await client.query(`SELECT to_regclass('public.${TABLE}') AS reg`);
  if (reg.rows[0]?.reg == null) return "no-table";
  const { rows } = await client.query(`SELECT deploy_env FROM public.${TABLE}`);
  return rows[0] ? (rows[0].deploy_env as Tier) : undefined;
}

async function tableCountExcludingMarker(client: MarkerClient): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND NOT (table_schema = 'public' AND table_name = '${TABLE}')`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Create the marker table (if needed) and claim the database, atomically. */
async function claim(client: MarkerClient, tier: Tier): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.${TABLE} (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
         deploy_env text NOT NULL CHECK (deploy_env IN ('production', 'staging')),
         set_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      `INSERT INTO public.${TABLE} (deploy_env) VALUES ($1) ON CONFLICT (singleton) DO NOTHING`,
      [tier],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

function mismatch(running: Tier, found: Tier): DeploymentMarkerError {
  return new DeploymentMarkerError(
    `This process is DEPLOY_ENV=${running} but its database is marked '${found}'. ` +
      `Refusing to boot: check DATABASE_URL points at the ${running} database.`,
  );
}

/**
 * Check (and, where allowed, set) the tier marker of the database `client` is connected to.
 * Call it while holding the shared migration lock, BEFORE migrating. Throws
 * DeploymentMarkerError when the database belongs to the other tier or cannot be claimed.
 */
export async function ensureDeploymentMarker(
  client: MarkerClient,
  deployEnv: DeployEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (deployEnv === "development") {
    if ((await readMarker(client)) === "production") {
      throw new DeploymentMarkerError(
        "This process is DEPLOY_ENV=development but its database is marked 'production'. " +
          "Refusing to boot: development must not run against the production database.",
      );
    }
    return;
  }
  const running: Tier = deployEnv;

  const existing = await readMarker(client);
  if (existing === "production" || existing === "staging") {
    if (existing !== running) throw mismatch(running, existing);
    return;
  }

  if (running === "production") {
    await claim(client, "production");
  } else {
    if (!flagIsSet(env.INIT_DEPLOY_MARKER)) {
      throw new DeploymentMarkerError(
        "This staging database has no deployment marker, so it is not known to be a staging " +
          "database. Refusing to boot. If DATABASE_URL is the new, empty staging database, set " +
          "INIT_DEPLOY_MARKER=1 for ONE boot to claim it, then unset it.",
      );
    }
    const others = await tableCountExcludingMarker(client);
    if (others > 0) {
      throw new DeploymentMarkerError(
        `INIT_DEPLOY_MARKER=1 was set but this database is not empty (${others} existing ` +
          "tables), so it will not be claimed as staging. Point DATABASE_URL at a fresh database.",
      );
    }
    await claim(client, "staging");
  }

  // Re-read: a concurrent process on the same database may have claimed it first
  // (the primary key lets exactly one insert win).
  const after = await readMarker(client);
  if (after === "production" || after === "staging") {
    if (after !== running) throw mismatch(running, after);
    return;
  }
  throw new DeploymentMarkerError("The deployment marker could not be read back after claiming.");
}
