import { Kysely, sql } from 'kysely';

// Per-CPID magnitude totals, keyed by the UTC year of the superblock's
// block time, plus an all-time bucket at year 0. The /researchers/history
// series endpoints rank the top-N CPIDs of a height range by
// SUM(magnitude); the whole-chain variant did that as a GROUP BY over all
// of superblock_magnitudes (3.6M rows) on every cold cache rebuild — the
// one "still-known sink" left in NOTES.md, and on the 768 MB-pool / HDD
// prod slice a scan the bot traffic keeps permanently cold. Totals only
// move when a superblock lands (~daily), so they belong in a rollup:
// RollupMaintainer recomputes the year bucket(s) a superblock landed in
// and re-derives year 0 from the year rows.
//
// (bucket_year, total_magnitude, cpid) covers the ranking query, so
// `WHERE bucket_year = ? ORDER BY total_magnitude DESC LIMIT n` is a
// backward index scan with no row lookups (NOTES.md planner gotcha 1:
// MariaDB only walks a secondary index in order for covered projections).
//
// Seeded here from full history: one pass over superblock_magnitudes
// joined to the ~3k superblock heights' years, then year 0 from the year
// rows. A one-time cost on the box running the migration.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS cpid_magnitude_totals (
      bucket_year     SMALLINT UNSIGNED NOT NULL,
      cpid            VARCHAR(32) NOT NULL,
      total_magnitude DOUBLE NOT NULL DEFAULT 0,
      superblocks     INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_year, cpid),
      KEY idx_cmt_year_total (bucket_year, total_magnitude, cpid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);
  await sql`
    INSERT INTO cpid_magnitude_totals (bucket_year, cpid, total_magnitude, superblocks)
    SELECT sy.y, m.cpid, SUM(m.magnitude), COUNT(*)
    FROM superblock_magnitudes m
    JOIN (
      SELECT s.height, YEAR(b.time) AS y
      FROM superblocks s JOIN blocks b ON b.height = s.height
    ) sy ON sy.height = m.superblock_height
    WHERE m.magnitude > 0
    GROUP BY sy.y, m.cpid
    ON DUPLICATE KEY UPDATE
      total_magnitude = VALUES(total_magnitude),
      superblocks = VALUES(superblocks)
  `.execute(db);
  await sql`
    INSERT INTO cpid_magnitude_totals (bucket_year, cpid, total_magnitude, superblocks)
    SELECT 0, cpid, SUM(total_magnitude), SUM(superblocks)
    FROM cpid_magnitude_totals
    WHERE bucket_year > 0
    GROUP BY cpid
    ON DUPLICATE KEY UPDATE
      total_magnitude = VALUES(total_magnitude),
      superblocks = VALUES(superblocks)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS cpid_magnitude_totals`.execute(db);
}
