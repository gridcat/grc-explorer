import { Kysely, sql } from 'kysely';

// Covering index for the superblock-detail magnitudes fetch
// (routes/superblocks.ts GET /:height) — same medicine as 0010-0013.
//
//   SELECT cpid, magnitude FROM superblock_magnitudes
//   WHERE superblock_height = H ORDER BY magnitude DESC
//
// The PK is (cpid, superblock_height) and the only secondary index was
// idx_superblock_magnitudes_height (superblock_height). So the planner
// located the ~1200 rows for the superblock via that height index and
// then did ONE random row lookup per row just to read `magnitude` and
// `cpid`, plus a filesort to order by magnitude. Warm that's a few ms,
// but on the 768 MB-buffer-pool / HDD prod slice each of those ~1200
// lookups is a cold random seek — ~10 s for a recent superblock, and it
// evicts other hot pages while doing it (measured: the superblock page
// stayed multi-second/500 even after the beacon-count fix until this
// arm was made index-only too).
//
// (superblock_height, magnitude, cpid) carries every column the query
// touches: the height equality selects the row group, `magnitude` right
// after it means the group is already ordered by magnitude so ORDER BY
// magnitude DESC is a backward index scan (no filesort), and `cpid`
// completes the covering set — pure in-index read, zero base-table
// lookups. The height-only index is dropped: this one is a superset on
// the same leading column, so nothing that used it regresses.

// Add + drop in ONE ALTER with explicit online DDL: on the live ROLE=all
// write target this is a single metadata-lock window (not two) with no
// transient both-indexes state, and LOCK=NONE keeps the indexer writing
// while the ~329 MB index builds. InnoDB does secondary-index add/drop
// inplace anyway; stating it makes the migration fail loudly rather than
// silently fall back to a blocking copy if that ever stops holding.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE superblock_magnitudes
      ADD INDEX IF NOT EXISTS idx_sbmag_height_mag (superblock_height, magnitude, cpid),
      DROP INDEX IF EXISTS idx_superblock_magnitudes_height,
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE superblock_magnitudes
      ADD INDEX IF NOT EXISTS idx_superblock_magnitudes_height (superblock_height),
      DROP INDEX IF EXISTS idx_sbmag_height_mag,
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}
