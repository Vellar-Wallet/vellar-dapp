// Read-only report: which migrations would the hash-based runner apply to the database
// in DATABASE_URL? Run it against a database BEFORE switching that database to the
// runner (packages/service-kit/src/migrations.ts), so a migration that drizzle's old
// timestamp migrator already applied but the runner would consider pending, or a table
// created outside the journal, is found by a person and not by a failed boot.
//
//   DATABASE_URL=... pnpm migration:dry-run
//
// It runs inside one BEGIN READ ONLY transaction (a command, so a connection pooler such
// as Neon's accepts it, unlike startup parameters) and refuses to continue unless the
// server confirms the transaction is read-only, so it cannot write even by mistake. It
// never prints the connection string. Exit code 1 if any pending migration is not
// plainly new.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describePlan, type MigrationPlan } from "../packages/service-kit/src/migrations";

const require = createRequire(new URL("../services/policy-service/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}

const folderOf = (service: string) =>
  fileURLToPath(new URL(`../services/${service}/drizzle`, import.meta.url));
const SERVICES = ["wallet-service", "policy-service", "verification-service"];

const pool = new pg.Pool({ connectionString: url, max: 1 });

async function main(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 30000");
    const ro = (await client.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only;
    if (ro !== "on") {
      console.error(
        `Refusing to continue: the transaction is not read-only (transaction_read_only=${ro}).`,
      );
      return 2;
    }
    console.log("transaction: READ ONLY confirmed (transaction_read_only=on)");

    const { rows: tableRows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log("tables in public:", tableRows.map((r) => r.table_name).join(", ") || "(none)");

    const plans: Array<[string, MigrationPlan]> = [];
    for (const service of SERVICES)
      plans.push([service, await describePlan(client, folderOf(service))]);

    console.log(`bookkeeping rows recorded: ${plans[0]![1].recordedCount}`);
    const seen = new Set<string>();
    const blockers: string[] = [];
    for (const [service, plan] of plans) {
      console.log(`\n== ${service} ==`);
      console.log("  files considered:");
      for (const c of plan.considered)
        console.log(
          `    ${c.recorded ? "recorded " : "NOT RECORDED"}  ${c.tag}  hash ${c.hash.slice(0, 12)}  journal when ${new Date(c.folderMillis).toISOString()}`,
        );
      console.log(`  recorded rows with no file in this checkout: ${plan.recordedNotOnDisk}`);
      if (plan.pending.length === 0) console.log("  pending: none");
      for (const p of plan.pending) {
        const dup = seen.has(p.hash) ? " (same file as one listed above; applied once)" : "";
        seen.add(p.hash);
        console.log(
          `  pending: ${p.tag}  hash ${p.hash.slice(0, 12)}  folderMillis ${p.folderMillis} (${new Date(p.folderMillis).toISOString()})${dup}`,
        );
        console.log(
          `           classification: ${p.classification}; creates: ${p.createsTables.join(", ") || "(no tables)"}`,
        );
        if (p.existingTables.length)
          console.log(`           ALREADY EXISTS in the database: ${p.existingTables.join(", ")}`);
        if (p.recordedHashAtSameTime)
          console.log(
            `           recorded at the same time under a different hash: ${p.recordedHashAtSameTime.slice(0, 12)}`,
          );
        if (p.classification !== "new") blockers.push(`${service}/${p.tag}: ${p.classification}`);
      }
    }
    const known = new Set(plans.flatMap(([, p]) => p.considered.map((c) => c.hash)));
    const orphans = plans[0]![1].recordedRows.filter((r) => !known.has(r.hash));
    console.log(`\nrecorded rows matching NO file in any service: ${orphans.length}`);
    for (const r of orphans)
      console.log(
        `  hash ${r.hash.slice(0, 12)}  created_at ${r.createdAt} (${r.createdAt ? new Date(r.createdAt).toISOString() : "?"})`,
      );
    console.log(
      blockers.length
        ? `\nBLOCKERS (${blockers.length}):\n  - ${blockers.join("\n  - ")}`
        : "\nNo blockers: every pending migration is plainly new.",
    );
    return blockers.length ? 1 : 0;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

process.exit(await main());
