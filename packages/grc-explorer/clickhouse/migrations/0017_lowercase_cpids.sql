-- One-shot normalisation: lowercase every CPID column on chain-derived
-- tables. CPIDs are MD5 hashes — case is incidental in their hex form
-- and BOINC's `user.gz` exports them lowercase. The wallet's RPC
-- emitted mixed case, which the indexer (pre-this-migration) stored
-- verbatim into chain tables. That left `lower(cpid)` mismatches
-- against the lowercase `project_users` and `mrc_requests` tables and
-- forced every consumer to wrap predicates in `lower(...)`.
--
-- Going forward, the indexer (ContractParser.ts) emits lowercase at
-- write time so no further mutation is needed.
--
-- Two shapes used here:
--   • ALTER UPDATE — for tables where cpid (or the cpid-flavoured
--     column) is NOT part of the ORDER BY tuple. ClickHouse runs the
--     mutation async; later merges incorporate the rewrite.
--   • INSERT + ALTER DELETE — for `superblock_magnitudes`, where cpid
--     IS in the ORDER BY tuple. CH refuses ALTER UPDATE on key
--     columns, so we materialise the lowercase variant as new rows
--     and DELETE the originals in a separate mutation.
--
-- `claim_mrcs` and `beacons` also have cpid in their ORDER BY, but a
-- pre-migration audit (`countIf(cpid != lower(cpid))`) showed zero
-- mixed-case rows on both — those tables were always written with
-- lowercase CPIDs in practice. The indexer fix keeps that invariant.

ALTER TABLE claims  UPDATE cpid        = lower(cpid)        WHERE cpid        IS NOT NULL;

ALTER TABLE blocks  UPDATE staker_cpid = lower(staker_cpid) WHERE staker_cpid IS NOT NULL;

ALTER TABLE votes   UPDATE voter_cpid  = lower(voter_cpid)  WHERE voter_cpid  IS NOT NULL;

-- IMPORTANT: do NOT alias the projection as `cpid` here. ClickHouse
-- resolves WHERE-clause identifiers to SELECT aliases first, so
-- aliasing `lower(cpid) AS cpid` would turn the predicate into
-- `lower(cpid) != lower(cpid)` (always false) and the INSERT writes
-- zero rows — a costly silent bug. `INSERT INTO ... (cpid, ...)`
-- matches columns by position, so the alias name doesn't matter.
INSERT INTO superblock_magnitudes (superblock_height, cpid, magnitude, _seq)
SELECT
  superblock_height,
  lower(cpid)                                AS cpid_lc,
  magnitude,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS new_seq
FROM superblock_magnitudes FINAL
WHERE cpid != lower(cpid);

ALTER TABLE superblock_magnitudes DELETE WHERE cpid != lower(cpid);
