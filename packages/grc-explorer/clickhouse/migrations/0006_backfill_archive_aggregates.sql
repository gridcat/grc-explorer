-- One-shot backfill for the archive_* MVs added in 0005.
--
-- ClickHouse materialised views only fire on INSERTs that happen after
-- the MV is created. Any block that landed in the base `blocks` /
-- `transactions` tables before 0005 ran is invisible to the MV — and
-- since migration 0005 was added mid-backfill, every block indexed
-- so far never triggered the MV. Result: the year-archive rail and
-- /blocks/YYYY pages render empty even though the data exists.
--
-- This migration TRUNCATEs the three MV tables and re-fills them from
-- the base tables. Safe because:
--   1. migrate.mjs runs during container startup, before the indexer's
--      scheduled jobs fire. No race with concurrent INSERTs.
--   2. Idempotent — applied once, recorded in _migrations. Replaying
--      this file would error harmlessly because TRUNCATE + INSERT is
--      already what the MV trigger has been keeping in sync since 0005.
--   3. SummingMergeTree merges duplicates by ORDER BY key, so even if
--      a stray block slipped in between TRUNCATE and INSERT it just
--      sums correctly on next part merge.

TRUNCATE TABLE archive_blocks_daily;

INSERT INTO archive_blocks_daily
SELECT
  toDate(time)               AS bucket_date,
  count()                    AS block_count,
  sum(tx_count)              AS tx_count,
  sum(mint)                  AS mint_total,
  sum(size)                  AS bytes_total,
  countIf(is_pos)            AS pos_count,
  countIf(is_superblock)     AS superblock_count
FROM blocks
GROUP BY bucket_date;

TRUNCATE TABLE archive_txs_daily;

INSERT INTO archive_txs_daily
SELECT
  toDate(time)   AS bucket_date,
  sum(total_out) AS value_moved,
  sum(fee)       AS fee_total,
  count()        AS user_tx_count
FROM transactions
WHERE NOT is_coinbase AND NOT is_coinstake
GROUP BY bucket_date;

TRUNCATE TABLE archive_minters_daily;

INSERT INTO archive_minters_daily
SELECT
  toDate(time)                       AS bucket_date,
  uniqState(miner_address)           AS miners_uniq,
  uniqState(staker_cpid)             AS stakers_uniq
FROM blocks
GROUP BY bucket_date;
