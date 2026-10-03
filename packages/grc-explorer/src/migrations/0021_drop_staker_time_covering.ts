import { Kysely, sql } from 'kysely';

// Drops idx_blocks_staker_time (0011). Its only consumer was the CPID
// cohort-retention builder, removed with the cohorts page. Every other
// staker_cpid query plans onto idx_blocks_time, idx_blocks_staker_cpid
// or idx_blocks_staker_miner_height (EXPLAIN-checked), so the index was
// pure write cost on every indexed block.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE blocks DROP INDEX IF EXISTS idx_blocks_staker_time`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_blocks_staker_time
      ON blocks (staker_cpid, time)
  `.execute(db);
}
