-- Per-block snapshot of the active mempool at the moment a block
-- landed. Captures the candidate set the staker had in view: every
-- tx that was first_seen <= block.time and not yet confirmed/evicted
-- by block.time. `was_included` flags the txs this same block then
-- confirmed.
--
-- Together with `mempool_txs` (which already keeps the full lifecycle
-- of every observed tx), this lets us answer questions that a snapshot
-- alone can't: tx ordering relative to block landing, fee-priority
-- behaviour, mempool depth over time at block-level resolution. It
-- doesn't help for the pre-watcher era — only blocks ingested while
-- the indexer was running will populate.
--
-- ReplacingMergeTree(_seq) so a reorg that re-ingests block N gets a
-- fresh snapshot row set rather than stacking a duplicate.
CREATE TABLE IF NOT EXISTS mempool_snapshots (
  block_height UInt32,
  block_hash   FixedString(64),
  block_time   DateTime CODEC(Delta, ZSTD(3)),
  captured_at  DateTime DEFAULT now(),
  tx_id        FixedString(64),
  first_seen   DateTime CODEC(Delta, ZSTD(3)),
  fee_estimate UInt64,
  size         UInt32,
  vin_count    UInt16,
  vout_count   UInt16,
  was_included Bool,
  _seq         UInt64
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_height, tx_id)
SETTINGS index_granularity = 8192;
