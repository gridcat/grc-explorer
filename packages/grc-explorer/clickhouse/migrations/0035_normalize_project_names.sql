-- One-shot normalisation: trim + lowercase project_name on every table
-- that stores it. The same BOINC project arrives through three ingest
-- paths (off-chain user.gz, on-chain whitelist contracts, on-chain
-- superblock contracts) with inconsistent casing — Moowrap/moowrap,
-- MilkyWay@home/milkyway@home, NFS@Home/nfs@home, Asteroids@home/
-- asteroids@home. Stored verbatim, one project splits into two or
-- three rows and the CPID / project pages list it multiple times.
--
-- Canonical form is trimmed lowercase (how BOINC's own base URLs and
-- user.gz exports spell projects). Going forward the indexer
-- (BlockWriter.ts) and the stats importer (BoincStatsImportJob.ts)
-- emit the canonical form at write time via lib/projectName, so no
-- further mutation is needed after this.
--
-- project_name is in the ORDER BY tuple of all four tables, and
-- ClickHouse refuses ALTER UPDATE on key columns. So we use the same
-- shape 0017 used for superblock_magnitudes: materialise the
-- normalised variant as new rows (fresh, larger _seq so they win the
-- ReplacingMergeTree merge against any pre-existing canonical twin),
-- then DELETE the non-canonical originals in a second mutation. Reads
-- already go through FINAL / _seq-dedup, so correctness holds before
-- background merges collapse the duplicates.
--
-- IMPORTANT (same trap as 0017): do NOT alias the projection as
-- `project_name`. ClickHouse resolves WHERE identifiers to SELECT
-- aliases first, so `lower(trimBoth(project_name)) AS project_name`
-- would make the predicate always-false and write zero rows. The
-- positional `INSERT INTO ... (cols)` matches by position, so the
-- alias name is irrelevant.

INSERT INTO project_users
  (cpid, project_name, user_id, name, country,
   total_credit, expavg_credit, create_time, last_imported_at, _seq)
SELECT
  cpid,
  lower(trimBoth(project_name))              AS project_name_norm,
  user_id, name, country,
  total_credit, expavg_credit, create_time, last_imported_at,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS new_seq
FROM project_users FINAL
WHERE project_name != lower(trimBoth(project_name));

ALTER TABLE project_users DELETE WHERE project_name != lower(trimBoth(project_name));

INSERT INTO project_user_imports
  (project_name, last_attempted_at, last_success_at,
   user_count, last_status, last_error, _seq)
SELECT
  lower(trimBoth(project_name))              AS project_name_norm,
  last_attempted_at, last_success_at,
  user_count, last_status, last_error,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS new_seq
FROM project_user_imports FINAL
WHERE project_name != lower(trimBoth(project_name));

ALTER TABLE project_user_imports DELETE WHERE project_name != lower(trimBoth(project_name));

INSERT INTO project_contracts
  (project_name, action, base_url, contract_version,
   tx_id, block_height, time, _seq)
SELECT
  lower(trimBoth(project_name))              AS project_name_norm,
  action, base_url, contract_version,
  tx_id, block_height, time,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS new_seq
FROM project_contracts FINAL
WHERE project_name != lower(trimBoth(project_name));

ALTER TABLE project_contracts DELETE WHERE project_name != lower(trimBoth(project_name));

INSERT INTO superblock_projects
  (superblock_height, project_name, average_rac, rac, total_credit, _seq)
SELECT
  superblock_height,
  lower(trimBoth(project_name))              AS project_name_norm,
  average_rac, rac, total_credit,
  toUInt64(toUnixTimestamp64Milli(now64(3))) AS new_seq
FROM superblock_projects FINAL
WHERE project_name != lower(trimBoth(project_name));

ALTER TABLE superblock_projects DELETE WHERE project_name != lower(trimBoth(project_name));
