import { Kysely, sql } from 'kysely';

// Finished API payloads that only change when a superblock lands, built
// in the background by services/jobs/SuperblockPrecomputeJob.ts so the
// request path never runs the build. One row per payload key (e.g.
// `researchers:history`, `researchers:series:year:2025`).
//
// `source_height` is the newest superblock height the payload reflects;
// the job rebuilds a key whenever it differs from the current one, which
// also covers reorgs and wipes. Not in CHAIN_HEIGHT_TABLES for that
// reason. `payload` is JSON text (the whole-chain series is ~3 MB).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS precomputed_payloads (
      cache_key     VARCHAR(64) NOT NULL,
      source_height INT UNSIGNED NOT NULL,
      payload       LONGTEXT NOT NULL,
      computed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cache_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS precomputed_payloads`.execute(db);
}
