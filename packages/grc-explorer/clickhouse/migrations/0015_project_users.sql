-- Off-chain BOINC user-stats mirror. Each row is one (cpid, project)
-- pair imported from a project's public `<base_url>/stats/user.gz`
-- export. Populated by BoincStatsImportJob on a daily cadence.
--
-- A CPID is `MD5(internal_uuid || email)` and is stable across every
-- BOINC project a user attaches with the same email, so the same
-- `cpid` can have rows under N project_names. The frontend picks a
-- preferred display name from the project with the highest
-- total_credit (most likely to be the user's primary project) and
-- falls back to any non-empty name otherwise.
--
-- We store rows for every user the project publishes, not just CPIDs
-- with beacons on Gridcoin. Storage is cheap (a few million rows
-- across the whitelist) and the extra rows let us answer "is this
-- CPID known to *any* whitelisted project" without re-fetching.
-- The Meili `cpid_names` index narrows down to beacon-attested CPIDs
-- at enqueue time so search results stay scoped to Gridcoin users.
--
-- Privacy: BOINC users opt-in to name publication (project profile
-- setting); empty/anonymous names are persisted as empty string and
-- treated as "Anonymous" downstream. A community-maintained denylist
-- (config/boinc-name-denylist.json) collapses explicit opt-outs at
-- ingest time — see BoincStatsImportJob.
--
-- ReplacingMergeTree(_seq) so a re-import naturally overwrites prior
-- snapshots without manual cleanup. ORDER BY (cpid, project_name)
-- supports the common "all names for one CPID" lookup with a single
-- index range scan; the project filter on the secondary index keeps
-- the per-project import-status query (count, last_imported_at) fast.
CREATE TABLE IF NOT EXISTS project_users (
  cpid              FixedString(32),
  project_name      LowCardinality(String),
  user_id           UInt64,
  name              String CODEC(ZSTD(3)),
  country           LowCardinality(String) DEFAULT '',
  total_credit      Float64 DEFAULT 0,
  expavg_credit     Float64 DEFAULT 0,
  create_time       UInt32 DEFAULT 0,
  last_imported_at  DateTime64(3, 'UTC') DEFAULT now64(3),
  _seq              UInt64,
  INDEX project_bloom project_name TYPE bloom_filter() GRANULARITY 4
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY tuple()
ORDER BY (cpid, project_name)
SETTINGS index_granularity = 8192;

-- Per-project ingest bookkeeping. Stores the last successful import
-- timestamp + row count so the job can skip projects it already
-- pulled today, and so the /projects route can surface "names known"
-- next to each project. Single-row-per-project ReplacingMergeTree.
CREATE TABLE IF NOT EXISTS project_user_imports (
  project_name      LowCardinality(String),
  last_attempted_at DateTime64(3, 'UTC') DEFAULT now64(3),
  last_success_at   DateTime64(3, 'UTC') DEFAULT toDateTime64(0, 3, 'UTC'),
  user_count        UInt32 DEFAULT 0,
  last_status       LowCardinality(String) DEFAULT '',
  last_error        String DEFAULT '' CODEC(ZSTD(3)),
  _seq              UInt64
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (project_name);
