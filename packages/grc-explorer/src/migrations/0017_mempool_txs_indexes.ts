import { Kysely, sql } from 'kysely';

// mempool_txs had only its PRIMARY KEY (tx_id), but it retains confirmed
// and evicted rows indefinitely, so two indexer-path reads on the API
// reader pool degrade to full scans of an ever-growing table — the same
// pool-starvation failure mode this batch targets, one table over:
//
//   MempoolWatcher.publishAggregate:
//     SELECT fee_estimate, size FROM mempool_txs
//     WHERE confirmed_at IS NULL AND evicted_at IS NULL
//   BlockWriter.mempoolFirstSeenWatermark:
//     SELECT min(first_seen) FROM mempool_txs
//
// idx_mempool_txs_active_agg (confirmed_at, evicted_at, fee_estimate,
// size): the active set is exactly the (NULL, NULL) prefix of this index
// — a small contiguous, index-only range no matter how much confirmed/
// evicted history piles up behind it. Covers fee_estimate + size so the
// aggregate never touches the base table.
//
// idx_mempool_txs_first_seen (first_seen): min(first_seen) becomes a
// single index seek instead of a full scan.
//
// Online DDL so it doesn't block the live indexer's mempool writes.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE mempool_txs
      ADD INDEX IF NOT EXISTS idx_mempool_txs_active_agg (confirmed_at, evicted_at, fee_estimate, size),
      ADD INDEX IF NOT EXISTS idx_mempool_txs_first_seen (first_seen),
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE mempool_txs
      DROP INDEX IF EXISTS idx_mempool_txs_active_agg,
      DROP INDEX IF EXISTS idx_mempool_txs_first_seen,
      ALGORITHM=INPLACE, LOCK=NONE
  `.execute(db);
}
