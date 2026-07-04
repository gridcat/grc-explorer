import { Kysely, sql } from 'kysely';

// Covering index for the CPID cohort-retention builder
// (routes/metrics.ts buildCohortRetention). Both of its queries want
// (staker_cpid, time) and nothing else:
//   SELECT staker_cpid, min(time) … GROUP BY staker_cpid
//   SELECT month(time), count(DISTINCT staker_cpid) WHERE staker_cpid IN (…)
// With only the narrow staker index available the first one does a
// random ROW lookup per staked block just to read `time` — ~85 s per
// cohort key on the 768M/HDD prod profile, and the cohorts page
// requests one key per cohort month, so a single visit stacked
// multiple of those scans and starved every other query (observed as
// unrelated pages 500ing on SSR timeout). Index-only, both queries
// drop to a sequential in-index scan.
//
// The narrow idx_blocks_staker_cpid is kept for the CPID blocks list's
// ORDER BY height backward scans (implicit-PK-suffix ordering — the
// planner won't get that from a wider index; see the rich-list saga).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_staker_time
      ON blocks (staker_cpid, time)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_staker_time`.execute(db);
}
