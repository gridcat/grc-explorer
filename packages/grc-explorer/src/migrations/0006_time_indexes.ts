import { Kysely, sql } from 'kysely';

// RollupMaintainer recomputes the trailing-24h rollup window after every
// applied batch with `WHERE time >= FROM_UNIXTIME(?)` on transactions
// (tx_5m, tx_1h, fee_quantiles_1h, archive_txs_daily) and
// `WHERE block_time >= ...` on claims (claims_5m, claims_1h,
// client_versions_daily). Neither column has ever had an index — the
// maintainer's header assumed one — so each refresh full-scans ~10M
// transactions ×4 and ~3.7M claims ×3, per block at the tip. EXPLAIN
// shows type=ALL on both. With the indexes the same statements become
// small range scans over the ~24h window (a few thousand rows).
//
// Plain single-column indexes on purpose: after pruning to the window,
// the row lookups land on pages the indexer just wrote (hot in the
// buffer pool), so a wide covering index would only add write
// amplification. Block time is monotonically increasing, so inserts
// append at the rightmost leaf — the cheapest secondary index shape.
//
// Also unblocks routes/metrics.ts' derived-tx window aggregation, which
// filters transactions on the same column.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions (time)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_claims_block_time ON claims (block_time)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE transactions DROP INDEX IF EXISTS idx_transactions_time`.execute(db);
  await sql`ALTER TABLE claims DROP INDEX IF EXISTS idx_claims_block_time`.execute(db);
}
