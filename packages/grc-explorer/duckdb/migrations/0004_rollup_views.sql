-- Rollup views — replace the ClickHouse materialized views (CH
-- migrations 0003 / 0004 / 0005 / 0007 / 0013 / 0008). ClickHouse kept
-- these as SummingMergeTree / AggregatingMergeTree MVs maintained on
-- every base-table INSERT because CH base-table scans were expensive
-- (time isn't in the sort key) and reorg re-inserts double-counted.
--
-- DuckDB is columnar and fast at these GROUP BYs, and `blocks.time` is
-- indexed (0001), so we express them as plain VIEWs recomputed on read.
-- This removes all write-path rollup maintenance AND the reorg double-
-- count problem (a view always reflects current base-table state). The
-- home dashboard filters by recent time (index-pruned, cheap); archive /
-- whole-chain views scan more but are swr-cached and bounded by the
-- DuckDB threads/memory caps. *State/*Merge aggregates become plain
-- min/max/avg/count(DISTINCT); the read path reads the final columns.
--
-- bucket_ts is UINTEGER unix-seconds (matches CH's UInt32 buckets so it
-- deserialises as a JSON number, not a string). bucket_date is DATE.

-- 5-minute / 1-hour / 1-day network rollups over blocks.
CREATE VIEW network_5m AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 300) * 300 AS UINTEGER) AS bucket_ts,
  count(*)      AS block_count,
  sum(tx_count) AS tx_count,
  sum(mint)     AS mint_total,
  sum(size)     AS bytes_total
FROM blocks
GROUP BY bucket_ts;

CREATE VIEW network_1h AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 3600) * 3600 AS UINTEGER) AS bucket_ts,
  count(*)      AS block_count,
  sum(tx_count) AS tx_count,
  sum(mint)     AS mint_total,
  sum(size)     AS bytes_total
FROM blocks
GROUP BY bucket_ts;

CREATE VIEW network_1d AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 86400) * 86400 AS UINTEGER) AS bucket_ts,
  count(*)      AS block_count,
  sum(tx_count) AS tx_count,
  sum(mint)     AS mint_total,
  sum(size)     AS bytes_total
FROM blocks
GROUP BY bucket_ts;

-- Money-flow rollups over user txs (coinbase + coinstake excluded).
CREATE VIEW tx_5m AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 300) * 300 AS UINTEGER) AS bucket_ts,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_ts;

CREATE VIEW tx_1h AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 3600) * 3600 AS UINTEGER) AS bucket_ts,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_ts;

-- Staking-subsidy rollups over claims, bucketed by the claimed block's
-- chain time (claims.block_time, denormalised by the writer).
CREATE VIEW claims_5m AS
SELECT
  CAST((CAST(epoch(block_time) AS BIGINT) // 300) * 300 AS UINTEGER) AS bucket_ts,
  sum(research_subsidy) AS research_subsidy_total,
  sum(block_subsidy)    AS block_subsidy_total
FROM claims
WHERE block_time IS NOT NULL
GROUP BY bucket_ts;

CREATE VIEW claims_1h AS
SELECT
  CAST((CAST(epoch(block_time) AS BIGINT) // 3600) * 3600 AS UINTEGER) AS bucket_ts,
  sum(research_subsidy) AS research_subsidy_total,
  sum(block_subsidy)    AS block_subsidy_total
FROM claims
WHERE block_time IS NOT NULL
GROUP BY bucket_ts;

-- Per-tx fee percentiles (fee per KB) in 1-hour buckets, over fee-bearing
-- user txs. CH stored a t-digest state; DuckDB computes the quantiles
-- directly.
CREATE VIEW fee_quantiles_1h AS
SELECT
  CAST((CAST(epoch(time) AS BIGINT) // 3600) * 3600 AS UINTEGER) AS bucket_ts,
  quantile_cont(fee * 1024.0 / size, 0.5)  AS p50,
  quantile_cont(fee * 1024.0 / size, 0.95) AS p95,
  quantile_cont(fee * 1024.0 / size, 0.99) AS p99,
  count(*)                                  AS tx_count
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake AND fee > 0 AND size > 0
GROUP BY bucket_ts;

-- Per-day archive aggregates for /blocks/YYYY[/MM[/DD]]. Month/year
-- overviews re-bucket these daily rows at read time.
CREATE VIEW archive_blocks_daily AS
SELECT
  CAST(time AS DATE)                  AS bucket_date,
  count(*)                            AS block_count,
  sum(tx_count)                       AS tx_count,
  sum(mint)                           AS mint_total,
  sum(size)                           AS bytes_total,
  count(*) FILTER (WHERE is_pos)        AS pos_count,
  count(*) FILTER (WHERE is_superblock) AS superblock_count
FROM blocks
GROUP BY bucket_date;

CREATE VIEW archive_txs_daily AS
SELECT
  CAST(time AS DATE) AS bucket_date,
  sum(total_out)     AS value_moved,
  sum(fee)           AS fee_total,
  count(*)           AS user_tx_count
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_date;

CREATE VIEW archive_minters_daily AS
SELECT
  CAST(time AS DATE)             AS bucket_date,
  count(DISTINCT miner_address)  AS miners_uniq,
  count(DISTINCT staker_cpid)    AS stakers_uniq
FROM blocks
GROUP BY bucket_date;

-- Per-day difficulty: min/max/avg + open (first block) / close (last
-- block) of the day. CH kept *State sketches; DuckDB computes directly.
CREATE VIEW difficulty_daily AS
SELECT
  CAST(time AS DATE)          AS bucket_date,
  min(difficulty)             AS difficulty_min,
  max(difficulty)             AS difficulty_max,
  avg(difficulty)             AS difficulty_avg,
  count(*)                    AS difficulty_count,
  arg_min(difficulty, height) AS difficulty_open,
  arg_max(difficulty, height) AS difficulty_close
FROM blocks
GROUP BY bucket_date;

-- Per-day PoS staker decomposition (researcher = CPID-bearing, investor
-- = no CPID). researcher + investor may slightly exceed total when an
-- address staked both with and without a CPID in one day; total_stakers
-- is authoritative.
CREATE VIEW stakers_daily AS
SELECT
  CAST(time AS DATE)                                              AS bucket_date,
  count(DISTINCT miner_address) FILTER (WHERE staker_cpid IS NOT NULL) AS researcher_stakers,
  count(DISTINCT miner_address) FILTER (WHERE staker_cpid IS NULL)     AS investor_stakers,
  count(DISTINCT miner_address)                                  AS total_stakers,
  sum(mint)                                                      AS mint_sum,
  count(*)                                                       AS pos_blocks
FROM blocks
WHERE is_pos
GROUP BY bucket_date;
