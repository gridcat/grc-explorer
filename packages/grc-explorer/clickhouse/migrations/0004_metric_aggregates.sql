-- Aggregate MVs that move emitMetricsTicks off full-table scans of
-- transactions / blocks / claims. The previous read shape recomputed
-- the per-bucket totals on every block-write batch, scanning the whole
-- transactions table because `time` isn't part of its sort key — the
-- per-batch cost grew linearly with table size and dominated backfill
-- latency once `transactions` crossed a few hundred thousand rows.
--
-- Every MV here is SummingMergeTree on `(bucket_ts)` with the bucket
-- expression baked in. Reads include a GROUP BY because partial sums
-- across parts only collapse on merge — equivalent to a FINAL but
-- much cheaper than a real FINAL scan of the base table.
--
-- Reorg trade-off: re-INSERTed rows are added again rather than
-- replaced (no _seq awareness in SummingMergeTree). Same compromise
-- network_5m / network_1h already accept; the canonical state lives
-- in Redis, these MVs are rebuildable from the base tables.

-- claims.block_time is the chain time of the block this claim is for.
-- Denormalised by the writer (BlockWriter.insertClaims) so the
-- claims_5m / claims_1h MVs can bucket by chain time without joining
-- against blocks (CH MV triggers can't see other base tables).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS block_time DateTime DEFAULT toDateTime(0);

-- Per-tx 5-minute aggregates over fee-bearing txs (cb/cs excluded — they
-- aren't "user money moving"). Powers MoneyFlowChart's value_moved and
-- fee_total ticks.
CREATE MATERIALIZED VIEW IF NOT EXISTS tx_5m
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 300) * 300) AS bucket_ts,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_ts;

-- 1-hour version for the longer dashboard window (last 24h chart).
CREATE MATERIALIZED VIEW IF NOT EXISTS tx_1h
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_ts;

-- Per-claim 5-minute aggregates of staking subsidies. Bucketed by
-- claim.block_time, which the writer denormalises from the block
-- being claimed. The `block_time > 0` guard skips claim rows from
-- before this column existed — they show up as `block_time = 0` and
-- would otherwise cluster into the 1970-01-01 bucket.
CREATE MATERIALIZED VIEW IF NOT EXISTS claims_5m
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(block_time), 300) * 300) AS bucket_ts,
  sum(research_subsidy) AS research_subsidy_total,
  sum(block_subsidy)    AS block_subsidy_total
FROM claims
WHERE block_time > toDateTime(0)
GROUP BY bucket_ts;

CREATE MATERIALIZED VIEW IF NOT EXISTS claims_1h
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(toDateTime(bucket_ts))
ORDER BY (bucket_ts)
AS SELECT
  toUInt32(intDiv(toUInt32(block_time), 3600) * 3600) AS bucket_ts,
  sum(research_subsidy) AS research_subsidy_total,
  sum(block_subsidy)    AS block_subsidy_total
FROM claims
WHERE block_time > toDateTime(0)
GROUP BY bucket_ts;
