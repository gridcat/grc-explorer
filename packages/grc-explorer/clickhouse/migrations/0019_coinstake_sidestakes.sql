-- Per-block mandatory sidestake payouts. One row per CoinStake vout
-- (vout index ≥ 2 on a PoS block) whose destination address matches
-- the active `mandatory_sidestakes` registry at the block's height.
--
-- Why a dedicated table instead of a flag on tx_outputs: MSS payouts
-- are a hot read for the home-page tile + per-recipient pages, and
-- joining the registry vs. scanning tx_outputs across millions of
-- coinstakes would burn CPU. A purpose-built table keyed by recipient
-- + height keeps every relevant query an indexed scan.
--
-- Activation: only populated for blocks ≥ V13 (mainnet 3,989,800,
-- testnet 2,870,000) — pre-V13 the daemon rejects sidestake contracts,
-- so the registry is empty there and no rows would be produced anyway.
-- The indexer skips the scan unconditionally below V13 as a tiny perf
-- shortcut.
--
-- Reorg discipline: ReplacingMergeTree(_seq) — on reorg, the indexer
-- re-extracts the new chain's blocks with a bumped _seq, and the old
-- rows for the abandoned heights collapse on next merge.
--
-- ORDER BY (address, block_height, vout_idx) makes per-recipient
-- timeline queries sorted scans. LowCardinality on address shaves
-- storage (the active recipient set is tiny by consensus design:
-- ≤ 4 simultaneously, capped at 25% total allocation).
CREATE TABLE IF NOT EXISTS coinstake_sidestakes (
  address            LowCardinality(String),
  block_height       UInt32,
  vout_idx           UInt16,
  tx_id              FixedString(64),
  amount             UInt64,          -- halford precision (1 GRC = 1e8 halford)
  allocation_pct     Float64,         -- recipient's allocation % at the block's height
  time               DateTime CODEC(Delta, ZSTD(3)),
  _seq               UInt64,
  _ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (address, block_height, vout_idx)
SETTINGS index_granularity = 8192;
