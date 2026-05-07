-- Materialized views that absorb the previous explicit aggregate tables
-- (`addresses`, `metric_buckets`, `fee_percentiles`). Each MV updates
-- automatically on every INSERT into its base table; the indexer no
-- longer maintains these by hand. Reads on the MV use *Merge functions
-- that finalise the partial states stored on disk.

-- Current-balance-per-address used to live here as `addresses_current`
-- via argMaxState/argMaxMerge over running_* columns. Retired: the
-- canonical current-state projection moved to Redis (`wallet:{addr}`
-- HSET + `wallets:by_balance` ZSET) so we get O(1) reads without the
-- argMaxMerge tiebreak window during reorgs. address_balance_history
-- is now a lean delta-only event log; running totals never enter CH.

-- 5-minute network rollups (replaces metric_buckets `5min`). The home
-- dashboard reads buckets here for "blocks/txs/mint over the last hour".
-- SummingMergeTree does the rollup as parts merge.
CREATE MATERIALIZED VIEW IF NOT EXISTS network_5m
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 300) * 300) AS bucket_ts,
  count()                                      AS block_count,
  sum(tx_count)                                AS tx_count,
  sum(mint)                                    AS mint_total,
  sum(size)                                    AS bytes_total
FROM blocks
GROUP BY bucket_ts;

-- 1-hour rollups (replaces metric_buckets `1h`). Bigger window for the
-- "last 24h" charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS network_1h
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
  count()                                        AS block_count,
  sum(tx_count)                                  AS tx_count,
  sum(mint)                                      AS mint_total,
  sum(size)                                      AS bytes_total
FROM blocks
GROUP BY bucket_ts;

-- 1-day rollups (replaces metric_buckets `1d`). Drives the long-range
-- "last 30d / 90d" charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS network_1d
ENGINE = SummingMergeTree()
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 86400) * 86400) AS bucket_ts,
  count()                                          AS block_count,
  sum(tx_count)                                    AS tx_count,
  sum(mint)                                        AS mint_total,
  sum(size)                                        AS bytes_total
FROM blocks
GROUP BY bucket_ts;

-- Per-tx fee percentiles in 1-hour buckets. quantilesTDigestState
-- maintains a t-digest sketch per partition; quantilesTDigestMerge
-- collapses sketches across partitions on read. Replaces the
-- explicit fee_percentiles table that FeePercentileJob used to maintain.
--
-- Excludes coinbase + coinstake (they have no real "fee per kb"
-- semantics) and zero-fee txs (some legacy txs slipped through with
-- fee=0; would skew the low percentile).
CREATE MATERIALIZED VIEW IF NOT EXISTS fee_quantiles_1h
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 3600) * 3600)            AS bucket_ts,
  quantilesTDigestState(0.5, 0.95, 0.99)(fee * 1024 / size) AS quantile_state,
  countState()                                              AS tx_count_state
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake AND fee > 0 AND size > 0
GROUP BY bucket_ts;
