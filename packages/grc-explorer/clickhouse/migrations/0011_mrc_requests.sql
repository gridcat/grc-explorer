-- v12+ MRC (Manual Researcher Compensation) request transactions.
-- Researchers submit one of these to the network and a future staker
-- bundles its payout into their block's claim. `claim_mrcs` records
-- the *payouts* (one row per cpid in a block); this table records the
-- *requests* (one row per submission tx) so the two can be paired
-- through the mempool → block lifecycle.
--
-- block_height / block_time are NULL while the request is pending in
-- mempool, populated when the block carrying the matching payout lands.
-- ReplacingMergeTree(_seq) collapses the pending and confirmed
-- versions to the latest write.
CREATE TABLE IF NOT EXISTS mrc_requests (
  tx_id            FixedString(64),
  cpid             FixedString(32),
  client_version   String CODEC(ZSTD(3)),
  organization     String CODEC(ZSTD(3)),
  research_subsidy UInt64,
  fee_offered      UInt64,
  magnitude        Float64,
  magnitude_unit   Float64,
  last_block_hash  FixedString(64),
  pay_to_address   Nullable(String),
  first_seen       DateTime CODEC(Delta, ZSTD(3)),
  block_height     Nullable(UInt32),
  block_time       Nullable(DateTime) CODEC(Delta, ZSTD(3)),
  _seq             UInt64,
  _ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (tx_id)
SETTINGS index_granularity = 8192;
