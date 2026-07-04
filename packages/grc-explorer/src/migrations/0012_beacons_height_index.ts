import { Kysely, sql } from 'kysely';

// The beacons list (newest-first, ORDER BY block_height DESC, tx_id
// DESC) had no height-leading index — the PK is (cpid, block_height,
// tx_id) — so every unfiltered page was a full-table read + filesort.
// Warm that's fine (48k rows), but the table's pages scatter across
// the tablespace, so each time buffer-pool pressure evicts it the next
// /beacons visit pays ~6-10 s of random HDD reads (recurred repeatedly
// during the 2 GB prod simulation).
//
// (block_height, tx_id) explicitly: with the PK appended the actual
// key is (block_height, tx_id, cpid), so a backward scan matches the
// list's ORDER BY as a pure prefix — 25 entries read, no sort. The
// route pairs this with a two-phase fetch (covered page query, then
// PK lookups) because the planner won't use the index for an
// uncovered ORDER BY (see the address_state rich-list saga).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_beacons_height_tx
      ON beacons (block_height, tx_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE beacons DROP INDEX IF EXISTS idx_beacons_height_tx`.execute(db);
}
