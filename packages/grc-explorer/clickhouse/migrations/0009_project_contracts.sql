-- On-chain BOINC project lifecycle events. Each row is a single
-- `type: "project"` contract from the chain, action `A` (whitelist add)
-- or `D` (de-list / remove). The body emitted by the daemon's
-- ProjectToJson is `{ version, name, url }` — see Gridcoin-Research's
-- src/rpc/rawtransaction.cpp (verified 2026-05-02).
--
-- We DO NOT track auto-greylist transitions in this table — those are
-- protocol-derived state, not on-chain contracts (auto-greylist
-- recomputes per superblock from per-project total_credit which we
-- already index in superblock_projects). Manual greylist transitions
-- show up here only if the community ever encoded them as project
-- REMOVE+ADD pairs; usually they're poll outcomes (see polls table).
--
-- Reorg discipline: same as every other contract table — re-extract
-- on reorg with bumped _seq, ReplacingMergeTree picks the latest.
--
-- ORDER BY (project_name, block_height, tx_id) makes per-project
-- timeline queries sorted scans (the dominant /projects/:name read).
-- LowCardinality(project_name) — there are only ~70 unique BOINC
-- projects across all of Gridcoin's history; storing as a dictionary
-- shaves storage and turns name-equality predicates into id compares.
CREATE TABLE IF NOT EXISTS project_contracts (
  project_name      LowCardinality(String),
  action            LowCardinality(String),
  base_url          String CODEC(ZSTD(3)),
  contract_version  UInt8,
  tx_id             FixedString(64),
  block_height      UInt32,
  time              DateTime CODEC(Delta, ZSTD(3)),
  _seq              UInt64,
  _ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (project_name, block_height, tx_id)
SETTINGS index_granularity = 8192;
