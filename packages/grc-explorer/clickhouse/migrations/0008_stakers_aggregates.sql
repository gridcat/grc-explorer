-- Per-day active-staker aggregates. Powers the /network/stakers page —
-- a whole-chain stacked-area chart decomposing each day's stakers into
-- researcher (CPID-bearing) and investor (no CPID) participants, plus
-- a per-year small-multiple grid in the same shape.
--
-- archive_minters_daily (0005) already keeps `uniqState(miner_address)`
-- and `uniqState(staker_cpid)`, but those answer different questions:
-- "how many distinct miner addresses produced ANY block today" (PoW +
-- PoS lumped together) and "how many distinct CPIDs claimed research
-- today" (CPID-keyed, not address-keyed). The stakers page wants
-- address-keyed counts conditional on CPID presence, scoped to PoS
-- only — different domain, different MV.
--
-- Why filter `WHERE is_pos`: PoW blocks have NULL staker_cpid by
-- definition, so a `staker_cpid IS NULL` predicate would lump pre-2014
-- PoW miners into "investor stakers". Filtering at the MV level keeps
-- the semantics honest.
--
-- Decomposition caveat: an address can appear in BOTH `researcher_stakers`
-- and `investor_stakers` on the same day if it staked once with a CPID
-- and once without (e.g. mid-day beacon expiry). researcher + investor
-- can therefore exceed `total_stakers` by a small margin. Acceptable for
-- a chain-wide trend chart; the frontend treats `total_stakers` as the
-- authoritative count and the split as a near-decomposition.
--
-- Reorg trade-off (same as 0004/0005/0007): re-INSERTed rows fold back
-- into the aggregate states. uniq* states are commutative and converge;
-- sumState(mint) and countState() may double-count during reorg replay
-- until the partition merges out duplicates. Rebuildable from `blocks`.

CREATE MATERIALIZED VIEW IF NOT EXISTS stakers_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket_date)
ORDER BY (bucket_date)
AS SELECT
  toDate(time)                                          AS bucket_date,
  uniqIfState(miner_address, staker_cpid IS NOT NULL)   AS researcher_stakers,
  uniqIfState(miner_address, staker_cpid IS NULL)       AS investor_stakers,
  uniqState(miner_address)                              AS total_stakers,
  sumState(toUInt64(mint))                              AS mint_sum,
  countState()                                          AS pos_blocks
FROM blocks
WHERE is_pos
GROUP BY bucket_date;

-- One-shot backfill so historic blocks (which never INSERTed through the
-- new MV trigger because the MV didn't exist when they landed) populate
-- the table. Same pattern as 0006 / 0007; safe because migrate.mjs runs
-- at startup before scheduled jobs fire and the `_migrations` row makes
-- it idempotent.
INSERT INTO stakers_daily
SELECT
  toDate(time)                                          AS bucket_date,
  uniqIfState(miner_address, staker_cpid IS NOT NULL)   AS researcher_stakers,
  uniqIfState(miner_address, staker_cpid IS NULL)       AS investor_stakers,
  uniqState(miner_address)                              AS total_stakers,
  sumState(toUInt64(mint))                              AS mint_sum,
  countState()                                          AS pos_blocks
FROM blocks
WHERE is_pos
GROUP BY bucket_date;
