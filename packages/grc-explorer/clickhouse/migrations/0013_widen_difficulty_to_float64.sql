-- Widen `difficulty` columns from Decimal(30, 8) to Float64.
--
-- Why: mainnet getblock returns difficulty as a JS number; for some
-- block types (legacy PoR/PoW transitions, RPC corner cases that
-- expose the raw target rather than the inverted-difficulty view) the
-- value can land in the 1e23–1e25 range. Decimal(30, 8) caps the
-- integer side at 22 digits, so the indexer fails the INSERT with
-- "Decimal value is too big" and the chain stops advancing on that
-- block. The aggregate path in 0007_difficulty_aggregates.sql already
-- casts to Float64 on the way in, so storing Float64 throughout is
-- the obvious shape — and it matches what the wallet actually emits.
--
-- Precision trade: Float64 carries ~15-17 significant digits.
-- Difficulty is a display metric (sparkline, "current difficulty"
-- card), never an accounting value, so the precision loss past 15
-- digits is invisible to users.
--
-- Order of operations:
--   1. Drop the difficulty_daily MV. Its target table's *State binary
--      layout is parameterised by the source column's type; mixing
--      Decimal-state and Float64-state rows in one merge would corrupt
--      the aggregate.
--   2. ALTER the two source columns. CH supports Decimal → Float64
--      via MODIFY COLUMN; on a fresh mainnet indexer that hasn't
--      completed backfill the mutation is cheap.
--   3. Recreate the MV with the same definition. The inner state
--      table is recreated automatically, now keyed on Float64.
--   4. Backfill the MV from `blocks` (matches the original 0007
--      pattern — safe because migrate.mjs records the migration
--      atomically with the file run).

DROP VIEW IF EXISTS difficulty_daily;

ALTER TABLE blocks MODIFY COLUMN difficulty Float64;
ALTER TABLE network_snapshots MODIFY COLUMN difficulty Float64;

CREATE MATERIALIZED VIEW IF NOT EXISTS difficulty_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)                      AS bucket_date,
  minState(difficulty)              AS difficulty_min,
  maxState(difficulty)              AS difficulty_max,
  sumState(difficulty)              AS difficulty_sum,
  countState()                      AS difficulty_count,
  argMinState(difficulty, height)   AS difficulty_open,
  argMaxState(difficulty, height)   AS difficulty_close
FROM blocks
GROUP BY bucket_date;

INSERT INTO difficulty_daily
SELECT
  toDate(time)                      AS bucket_date,
  minState(difficulty)              AS difficulty_min,
  maxState(difficulty)              AS difficulty_max,
  sumState(difficulty)              AS difficulty_sum,
  countState()                      AS difficulty_count,
  argMinState(difficulty, height)   AS difficulty_open,
  argMaxState(difficulty, height)   AS difficulty_close
FROM blocks
GROUP BY bucket_date;
