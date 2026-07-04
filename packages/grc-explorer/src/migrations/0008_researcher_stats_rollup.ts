import { Kysely, sql } from 'kysely';

// Per-superblock researcher stats rollup. buildResearchersHistory —
// the default dataset behind /researchers/history — used to aggregate
// ALL of superblock_magnitudes (3.6M rows, ~540 MB) with a window
// function on every cold cache rebuild: ~15 s of CPU and, worse on the
// memory-capped prod box, a scan that evicts most of the buffer pool
// once per TTL. The per-superblock numbers are immutable once the
// superblock is final, so they belong in a maintained rollup:
// RollupMaintainer recomputes the trailing window per applied batch
// (superblocks arrive ~daily → 1-2 rows touched), and the endpoint
// reads ~3k rows joined to blocks.
//
// Seeded here with the full-history aggregation — a one-time cost on
// the box running the migration; prod receives it inside the physical
// seed.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS superblock_researcher_stats (
      superblock_height INT UNSIGNED NOT NULL,
      active            INT UNSIGNED NOT NULL DEFAULT 0,
      total_magnitude   DOUBLE NOT NULL DEFAULT 0,
      top10_magnitude   DOUBLE NOT NULL DEFAULT 0,
      PRIMARY KEY (superblock_height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);
  await sql`
    INSERT INTO superblock_researcher_stats
      (superblock_height, active, total_magnitude, top10_magnitude)
    SELECT
      superblock_height,
      SUM(CASE WHEN magnitude > 0 THEN 1 ELSE 0 END),
      COALESCE(SUM(magnitude), 0),
      COALESCE(SUM(CASE WHEN rn <= 10 AND magnitude > 0 THEN magnitude ELSE 0 END), 0)
    FROM (
      SELECT
        superblock_height,
        magnitude,
        ROW_NUMBER() OVER (PARTITION BY superblock_height ORDER BY magnitude DESC) AS rn
      FROM superblock_magnitudes
    ) ranked
    GROUP BY superblock_height
    ON DUPLICATE KEY UPDATE
      active = VALUES(active),
      total_magnitude = VALUES(total_magnitude),
      top10_magnitude = VALUES(top10_magnitude)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS superblock_researcher_stats`.execute(db);
}
