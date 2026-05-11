-- On-chain protocol-parameter registry. Each row is a single
-- `type: "protocol"` contract from the chain, action `A` (set) or
-- `D` (clear). The wallet's `ProtocolRegistry` (src/gridcoin/protocol.cpp)
-- maintains an in-memory key→value map populated by replaying every
-- ADD/REMOVE contract in chain order; downstream code (notably
-- voting/poll.cpp::ResolveMagnitudeWeightFactor) walks the history
-- chain via `TryLastBeforeTimestamp(key, ts)` to find the value
-- effective at a given point in time.
--
-- Known keys (non-exhaustive; the registry is open-ended): the most
-- audit-relevant for the explorer is `magnitudeweightfactor`, set
-- at V13+ to drive `BALANCE_AND_MAGNITUDE` poll weighting away from
-- the hardcoded 100/567 fraction. See
-- `reference_gridcoin_voting_weight_rules.md` for the formula.
--
-- Reorg discipline: same as every other contract table — re-extract
-- on reorg with bumped _seq; ReplacingMergeTree picks the latest.
--
-- ORDER BY (key, time, tx_id) gives sorted scans for the
-- "value at timestamp T" lookup that the poll aggregator does on
-- every closed V13+ poll. `key` is LowCardinality — the wallet
-- restricts protocol-entry keys to a small known set.
--
-- previous_hash is a chain pointer (each entry references the prior
-- entry for the same key). Not strictly needed for replay since we
-- already order by (key, time), but persisting it preserves the
-- wallet's full audit trail.
CREATE TABLE IF NOT EXISTS protocol_entries (
  key             LowCardinality(String),
  value           String CODEC(ZSTD(3)),
  status          LowCardinality(String),
  contract_version UInt8,
  tx_id           FixedString(64),
  previous_hash   FixedString(64),
  block_height    UInt32,
  time            DateTime CODEC(Delta, ZSTD(3)),
  _seq            UInt64,
  _ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (key, time, tx_id)
SETTINGS index_granularity = 8192;
