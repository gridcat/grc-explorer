-- Skip index on blocks.time.
--
-- `blocks` is ORDER BY (height) only, so every "...WHERE time <= X"
-- predicate (the time-machine anchor resolveAtHeight, WealthSnapshot's
-- heightAtTime, indexerTip min/max(time)) had no way to prune and fell
-- back to a ~2.4M-row scan. query_log showed `SELECT max(height) FROM
-- blocks ... WHERE time <= ?` running ~874x / 15min at ~29ms each plus
-- the heavier WealthSnapshot variants — all reading the whole table.
--
-- block time is monotonic with height and height IS the sort key, so
-- per-granule [min(time), max(time)] ranges are tight and ordered: a
-- minmax skip index turns "time <= X" into a granule range scan.
--
-- NOTE: this only bites once the matching queries drop FINAL — FINAL
-- forces the ReplacingMergeTree merge path and ignores skip indexes
-- (same reason it ignores projections, see 0027-0029). The paired
-- code change de-FINALs those reads; they're max()/argMax() over
-- columns that are immutable per block height, so the dedup FINAL
-- gave is unnecessary.
--
-- MATERIALIZE INDEX queues a one-time non-blocking background mutation
-- to build the index over existing parts — watch
-- `SELECT * FROM system.mutations WHERE is_done = 0`. New inserts get
-- it for free.

ALTER TABLE blocks
ADD INDEX IF NOT EXISTS idx_blocks_time time TYPE minmax GRANULARITY 1;

ALTER TABLE blocks
MATERIALIZE INDEX idx_blocks_time;
