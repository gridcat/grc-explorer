import { Kysely, sql } from 'kysely';

// Covering indexes for the address page's linked-wallets fan-out —
// same medicine as 0005, different tables. For a prolific staker
// (~45k staked blocks) the CPID-discovery arm
//   SELECT staker_cpid FROM blocks WHERE miner_address = ?
// located the entries via the narrow idx_blocks_miner_address and
// then did one random ROW lookup per staked block just to read
// staker_cpid — ~2.3 s warm, EVERY page view (measured; it was the
// dominant recurring cost left on /addresses/:addr after the
// address_txs projection). Widening to (miner_address, staker_cpid)
// makes it index-only. The narrow index is dropped: the covering one
// is a superset on the same leading column.
//
// The sibling arm
//   ... FROM blocks WHERE staker_cpid IN (?) GROUP BY staker_cpid,
//   miner_address (+ min/max height)
// has the same shape via idx_blocks_staker_cpid, so it gets a
// covering (staker_cpid, miner_address, height) — also serving the
// CPID page's per-address staked-block rollup (routes/cpids.ts). The
// narrow staker index is KEPT: the CPID blocks list relies on its
// (staker_cpid, height-PK) shape for backward ORDER BY height scans,
// and the planner does not reliably use suffix columns of the wider
// index for that (see the address_state rich-list saga).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_miner_cpid
      ON blocks (miner_address, staker_cpid)
  `.execute(db);
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_miner_address`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_staker_miner_height
      ON blocks (staker_cpid, miner_address, height)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_miner_address ON blocks (miner_address)
  `.execute(db);
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_miner_cpid`.execute(db);
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_staker_miner_height`.execute(db);
}
