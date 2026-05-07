-- Per-day difficulty aggregates. Powers the /network/difficulty page —
-- a single line chart spanning the whole chain (daily average, rendered
-- on a log axis) plus a per-year small-multiple grid showing min/avg/max
-- ribbons. Reading the raw `blocks.difficulty` for a year-long window
-- already costs a partition scan; this MV collapses it to ~365 rows per
-- year, microseconds to render.
--
-- AggregatingMergeTree(*State) instead of SummingMergeTree because:
--   - min/max can't be expressed as a sum; they need their own merge state.
--   - avg needs paired sum + count (Decimal(30,8) → toFloat64 cast on the
--     way in keeps avgState arithmetic in double precision so the late-
--     mainnet difficulty values don't saturate the decimal scale).
--   - argMin/argMax over `height` give us per-day "open" (first block of
--     the day) and "close" (last block of the day) without reading raw
--     rows, useful for daily candlesticks if/when we add them.
--
-- Reorg trade-off (same as 0003/0004/0005): re-INSERTed rows fold back
-- into the aggregate states. min/max stay correct (commutative); sum +
-- count both increment, so a duplicated re-insert during reorg replay
-- inflates the per-day average toward 2× truth until the affected day's
-- partition merges out the duplicates. Acceptable for a chain-historical
-- chart; rebuildable from `blocks` if it ever drifts (see wipeExplorer's
-- MV_REBUILDS).

CREATE MATERIALIZED VIEW IF NOT EXISTS difficulty_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)                      AS bucket_date,
  minState(difficulty)              AS difficulty_min,
  maxState(difficulty)              AS difficulty_max,
  sumState(toFloat64(difficulty))   AS difficulty_sum,
  countState()                      AS difficulty_count,
  argMinState(difficulty, height)   AS difficulty_open,
  argMaxState(difficulty, height)   AS difficulty_close
FROM blocks
GROUP BY bucket_date;

-- One-shot backfill so historic blocks (which never INSERTed through the
-- new MV trigger because the MV didn't exist when they landed) populate
-- the table. Same pattern as 0006_backfill_archive_aggregates.sql; safe
-- because migrate.mjs runs at startup before scheduled jobs fire and
-- the `_migrations` row makes it idempotent.
INSERT INTO difficulty_daily
SELECT
  toDate(time)                      AS bucket_date,
  minState(difficulty)              AS difficulty_min,
  maxState(difficulty)              AS difficulty_max,
  sumState(toFloat64(difficulty))   AS difficulty_sum,
  countState()                      AS difficulty_count,
  argMinState(difficulty, height)   AS difficulty_open,
  argMaxState(difficulty, height)   AS difficulty_close
FROM blocks
GROUP BY bucket_date;
