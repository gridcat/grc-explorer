import { Kysely, sql } from 'kysely';

// Index for getV11BlockTimestamp() (lib/indexerTip.ts):
//
//   SELECT UNIX_TIMESTAMP(min(time)) FROM blocks WHERE n_version >= 11
//
// `n_version` was unindexed, so this was a FULL SCAN of the ~3.9M-row
// blocks table — ~8 s warm, but ~8 MINUTES cold on the HDD / 768 MB-pool
// prod slice (confirmed in prod's processlist: an 8-minute `min(time) …
// WHERE n_version >= 11`). The beacons endpoint awaits this on every
// request; it's single-flight + cached-forever, but the first call after
// each container restart blocks /beacons for the whole scan AND holds an
// API reader connection the entire time.
//
// (n_version, time) makes it index-only: the min time in the n_version>=11
// range is the first entry of the n_version=11 group, so MariaDB reads it
// straight from the index. Validated on the replica: full-scan 8.24 s ->
// range/Using index 0.38 s. Composite (not just (n_version)) so `time`
// is covered and no base-table row lookups are needed.

// Online DDL (ALGORITHM=INPLACE, LOCK=NONE) so the index builds on the
// 3.9M-row blocks table without blocking the live ROLE=all indexer writes.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE blocks
      ADD INDEX IF NOT EXISTS idx_blocks_nversion_time (n_version, \`time\`),
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE blocks
      DROP INDEX IF EXISTS idx_blocks_nversion_time,
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}
