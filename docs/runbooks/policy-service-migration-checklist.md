# policy-service schema migration rollout checklist

Issue #333. `policy-service`'s Postgres schema lives in
`services/policy-service/drizzle/` (Drizzle ORM). This is the first runbook
in `docs/runbooks/` — reference it from any migration PR's description, and
use it as the template for other services' schema-change runbooks as they're
written.

## How migrations actually apply here (read this before writing a checklist item)

`connectDb` (`services/policy-service/src/db/client.ts`) calls Drizzle's
`migrate()` **on every process boot**, not as a separate deploy step. This
shapes everything below:

- There is no "run migrations, then deploy the app" gate — new schema and new
  code land together, at whatever moment each replica happens to boot.
- A `pg_advisory_lock` (key `0x56454c41`) serializes concurrent migrators, so
  two replicas booting at once don't race each other applying the same
  migration — but it does NOT make migrations atomic with respect to
  **already-running** old-code replicas during a rolling deploy. For the
  entire rollout window, old code and new code are querying the **same**,
  now-migrated database concurrently.
- Consequence: **the migration must be safe for the previous version of the
  application code to run against**, for the whole rollout window — not just
  safe for the new code. This is the backward-compatibility requirement
  below, and it is not optional here the way it might be behind a separate
  migration gate.

## Checklist

Copy this list into the migration PR description and check off each item.

### 1. Backward compatibility

- [ ] The migration is additive only (`ADD COLUMN`, `CREATE TABLE`,
      `CREATE INDEX`), OR the removal/rename of anything is deferred to a
      **later, separate** migration after the old code is fully rolled out
      everywhere (see "phased destructive changes" below).
- [ ] Any new `NOT NULL` column either has a `DEFAULT`, or is added nullable
      first and tightened to `NOT NULL` in a later migration once every row
      has been backfilled.
- [ ] The previous release's code (the version being rolled OUT) still runs
      correctly against the NEW schema — walk through every query/insert path
      that touches the changed table and confirm none of them break. This is
      the one item that's easy to skip and the one this repo's boot-time
      migration model makes non-negotiable (see above).
- [ ] If the change touches `spend_ledger` or another table another service
      reads directly (rather than through this service's API), confirm the
      other service's queries were checked too.

### 2. Backfill

- [ ] Any data transformation needed for existing rows is either done IN the
      migration (safe for the table's real row count — see the row-count
      check below) or scheduled as an explicit, separate backfill step run
      AFTER the migration, before the column/constraint that depends on it
      goes live.
- [ ] For a table above a few hundred thousand rows: the migration was
      reviewed for lock duration — an `ALTER TABLE ... ADD COLUMN ... NOT
      NULL` without a default, or an index build without `CONCURRENTLY`,
      holds a table-level lock for the full duration and can stall the
      service. Prefer `CREATE INDEX CONCURRENTLY` (note: this cannot run
      inside a transaction — confirm Drizzle's migrator here doesn't wrap it
      in one, or split it into its own migration file if it does).

### 3. Rollback

- [ ] There is a concrete rollback plan written in the PR description — not
      just "we'll figure it out": either (a) the migration is safe to leave
      applied even if the accompanying code change is reverted (the
      preferred case for an additive migration), or (b) an explicit reverse
      migration is prepared and tested BEFORE the forward migration ships.
- [ ] If (b): the reverse migration was actually run against a copy of the
      post-migration schema to confirm it applies cleanly, not just reasoned
      about.
- [ ] Confirmed the migration cannot silently and irreversibly drop data
      (`DROP COLUMN`, `DROP TABLE`, a destructive `ALTER ... TYPE`) without an
      explicit sign-off in the PR description — these have no rollback once
      applied to a database with real data in it.

### 4. Drizzle-specific housekeeping

- [ ] `drizzle-kit generate` was used to produce the migration (not a
      hand-written `.sql` file added directly to `drizzle/`) — this keeps
      `drizzle/meta/*_snapshot.json` in sync, which the NEXT `generate` diffs
      against. **This repo currently has a gap here**: `0001_spend_ledger.sql`
      has no corresponding `drizzle/meta/0001_snapshot.json` (only `0000`'s
      snapshot exists), meaning the next `drizzle-kit generate` may not
      correctly diff against `0001`'s actual schema state. Fixing that gap is
      out of scope for this checklist, but any new migration should NOT
      repeat the pattern that caused it — always generate, never hand-write.
- [ ] The new file follows the existing numbering (`000N_description.sql`)
      and was added to `drizzle/meta/_journal.json` by the generator, not by
      hand.
- [ ] Ran the migration against a local Postgres (`docker compose -f
      infra/docker/docker-compose.yml up -d`, matching how CI/dev boot the
      service) and confirmed `pnpm --filter @vellar/policy-service dev` boots
      cleanly and applies it — this is the same boot-time path production
      uses, so a local dry run is a meaningfully accurate rehearsal.

## Worked example: `0001_spend_ledger.sql`

Walking the checklist against the one real migration this service has
shipped beyond its initial schema, as a concrete illustration:

```sql
CREATE TABLE "spend_ledger" (
    "id" text PRIMARY KEY NOT NULL,
    "line" text NOT NULL,
    "network" text NOT NULL,
    "stroops" bigint NOT NULL,
    "count" integer NOT NULL,
    "at" timestamp with time zone NOT NULL
);
CREATE INDEX "spend_ledger_line_network_at_idx"
    ON "spend_ledger" USING btree ("line","network","at");
```

- **Backward compatibility**: ✅ purely additive — a new table plus an index.
  Old code that has never heard of `spend_ledger` is entirely unaffected;
  there's no column added to an existing table for old queries to trip over.
- **Backfill**: ✅ not applicable — a brand-new table starts empty, so there's
  no existing-row transformation to schedule.
- **Rollback**: ✅ trivial — `DROP TABLE spend_ledger` loses nothing that
  existed before this migration, since the table (and everything written to
  it) is new. Safe to leave applied even if the code that reads/writes it is
  rolled back; the table just goes temporarily unused.
- **Drizzle housekeeping**: ❌ this is the migration that's missing its
  snapshot file (see item 4 above) — it appears to have been hand-written
  rather than generated. It's still functionally safe to apply (the SQL
  itself is correct and additive), which is why it's a useful worked example
  rather than a incident report, but it's exactly the gap this checklist
  exists to catch on the NEXT migration.

## See also

- `services/worker-service/README.md` — a similar honest-limitations /
  operational-runbook style for the build worker.
- `docs/security-audit.md` — the M-numbered findings referenced throughout
  this service's code comments (e.g. M6, M7) are the security review this
  migration model itself grew out of.
