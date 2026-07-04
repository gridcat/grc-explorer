import { Kysely, sql } from 'kysely';

// tx_outputs had no index leading with block_height — only the composite
// idx_tx_outputs_address (address, block_height), whose second-column
// block_height can't serve a `WHERE block_height = ?` lookup. The block
// detail path (buildBlockFlow) runs
//   SELECT ... FROM tx_outputs WHERE block_height = $h ORDER BY vout_n ASC
// which fell back to a full scan of the ~9.5M-row table (~40s cold). Blocks
// within DETAIL_CACHE_DEPTH of the tip are never Redis-cached, so every
// near-tip block view paid that cost and blew the frontend's 15s SSR axios
// timeout → 500.
//
// (block_height, vout_n) matches the sibling tables (idx_tx_inputs_block,
// idx_transactions_block) and covers the ORDER BY vout_n so the read is a
// tight range scan.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_tx_outputs_block ON tx_outputs (block_height, vout_n)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_tx_outputs_block ON tx_outputs`.execute(db);
}
