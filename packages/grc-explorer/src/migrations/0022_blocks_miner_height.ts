import { Kysely, sql } from 'kysely';

// Replaces idx_blocks_miner_cpid (0010) with (miner_address, height,
// staker_cpid) for GET /addresses/:address/blocks:
//   SELECT … FROM blocks WHERE miner_address = ? ORDER BY height DESC LIMIT n
// With staker_cpid between the address and the height PK suffix the
// old index can't return heights in order, so the planner walks the PK
// backwards filtering on miner_address — 122k rows read for a deep page
// of a 16k-block staker on testnet vs 15k with this index, 25 for page
// one. The CPID-discovery arm of fetchLinkedWallets stays index-only
// (staker_cpid is still in the index); it was the old index's only
// consumer, so one index serves both.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_miner_height
      ON blocks (miner_address, height, staker_cpid)
  `.execute(db);
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_miner_cpid`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_miner_cpid
      ON blocks (miner_address, staker_cpid)
  `.execute(db);
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_miner_height`.execute(db);
}
