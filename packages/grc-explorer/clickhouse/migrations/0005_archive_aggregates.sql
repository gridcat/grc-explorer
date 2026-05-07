-- Per-day aggregates that power the dated-archive pages
-- (/blocks/YYYY, /blocks/YYYY/MM, /blocks/YYYY/MM/DD).
--
-- Daily resolution is sufficient: month/year overviews re-bucket via
-- GROUP BY toStartOfMonth/toStartOfYear(bucket_date) at read time —
-- 365 daily rows is microsecond-cheap to scan, no benefit to a
-- separate monthly/yearly MV.
--
-- Why a new MV rather than reusing network_1d (0003_views.sql):
-- network_1d lacks `pos_count` and `superblock_count`, both of which
-- show on overview stat rows ("412 superblocks issued in 2024").
-- ALTER MATERIALIZED VIEW on SummingMergeTree-with-existing-data is
-- destructive; cheaper to add a parallel daily MV with the columns we
-- need. network_1d stays as-is for the existing dashboards.
--
-- Reorg trade-off (same as every other SummingMergeTree MV here):
-- re-INSERTed rows add again rather than replace, so pre-handoff
-- backfill rows in this MV may double-count after a reorg replay.
-- Rebuildable from `blocks` / `transactions` if it ever drifts.

CREATE MATERIALIZED VIEW IF NOT EXISTS archive_blocks_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)               AS bucket_date,
  count()                    AS block_count,
  sum(tx_count)              AS tx_count,
  sum(mint)                  AS mint_total,
  sum(size)                  AS bytes_total,
  countIf(is_pos)            AS pos_count,
  countIf(is_superblock)     AS superblock_count
FROM blocks
GROUP BY bucket_date;

-- Per-day money-flow aggregates over user txs (cb/cs excluded).
-- Mirrors tx_5m / tx_1h from 0004 but at daily granularity. Used on
-- year / month / day overview stat rows for "GRC moved" and "fees
-- collected over this period".
CREATE MATERIALIZED VIEW IF NOT EXISTS archive_txs_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)   AS bucket_date,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total,
  count()        AS user_tx_count
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_date;

-- Distinct miners + stakers per day, kept as a t-digest-style sketch
-- so monthly/yearly aggregates merge sketches rather than re-counting
-- raw rows. uniqMerge collapses partitions on read.
--
-- Sized for the archive narrative ("412 distinct miners minted blocks
-- in 2018") — not the hot path, so the AggregatingMergeTree overhead
-- is fine.
CREATE MATERIALIZED VIEW IF NOT EXISTS archive_minters_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)                       AS bucket_date,
  uniqState(miner_address)           AS miners_uniq,
  uniqState(staker_cpid)             AS stakers_uniq
FROM blocks
GROUP BY bucket_date;
