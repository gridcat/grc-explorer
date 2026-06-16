-- Project lifecycle, protocol registry, sidestakes, MRC requests,
-- mempool snapshots, address clusters. Squashed from CH migrations
-- 0009 / 0010 / 0011 / 0012 (mrc version, signature) / 0014 / 0015 /
-- 0018 / 0019 / 0034 into final shape. project_name is stored trimmed +
-- lowercase at write time (CH 0035 normalisation) so no per-read
-- lower(trim(...)) wrapping is needed. cpid columns are stored lowercase
-- at write time (CH 0017).

-- On-chain BOINC project whitelist events. action 'A' (add) / 'D'
-- (de-list). Per-project timeline is the dominant /projects/:name read.
CREATE TABLE IF NOT EXISTS project_contracts (
  project_name     VARCHAR NOT NULL,
  action           VARCHAR,
  base_url         VARCHAR,
  contract_version UTINYINT,
  tx_id            VARCHAR NOT NULL,
  block_height     UINTEGER NOT NULL,
  time             TIMESTAMP,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (project_name, block_height, tx_id)
);

-- On-chain protocol-parameter registry. action 'A' (set) / 'D' (clear).
-- The poll aggregator walks (key, time) history for the value effective
-- at a timestamp (e.g. magnitudeweightfactor at V13+).
CREATE TABLE IF NOT EXISTS protocol_entries (
  key              VARCHAR NOT NULL,
  value            VARCHAR,
  status           VARCHAR,
  contract_version UTINYINT,
  tx_id            VARCHAR NOT NULL,
  previous_hash    VARCHAR,
  block_height     UINTEGER NOT NULL,
  time             TIMESTAMP NOT NULL,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (key, time, tx_id)
);

-- Off-chain BOINC user-stats mirror, one row per (cpid, project) from a
-- project's user.gz export (BoincStatsImportJob, daily). The name index
-- serves the researcher-name / /cpids/resolve exact-match lookup (CH's
-- name bloom, 0032).
CREATE TABLE IF NOT EXISTS project_users (
  cpid             VARCHAR NOT NULL,
  project_name     VARCHAR NOT NULL,
  user_id          UBIGINT,
  name             VARCHAR,
  country          VARCHAR DEFAULT '',
  total_credit     DOUBLE DEFAULT 0,
  expavg_credit    DOUBLE DEFAULT 0,
  create_time      UINTEGER DEFAULT 0,
  last_imported_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (cpid, project_name)
);
CREATE INDEX IF NOT EXISTS idx_project_users_name ON project_users (name);

-- Per-project ingest bookkeeping (one row per project).
CREATE TABLE IF NOT EXISTS project_user_imports (
  project_name      VARCHAR PRIMARY KEY,
  last_attempted_at TIMESTAMP DEFAULT now(),
  last_success_at   TIMESTAMP,
  user_count        UINTEGER DEFAULT 0,
  last_status       VARCHAR DEFAULT '',
  last_error        VARCHAR DEFAULT ''
);

-- Mandatory sidestake registry (V13+). action 'A'/'D', status
-- MANDATORY/DELETED, allocation_pct from Allocation::ToPercent().
-- Per-destination allocation history is the dominant read.
CREATE TABLE IF NOT EXISTS mandatory_sidestakes (
  address          VARCHAR NOT NULL,
  action           VARCHAR,
  status           VARCHAR,
  allocation_pct   DOUBLE,
  description      VARCHAR,
  contract_version UTINYINT,
  tx_id            VARCHAR NOT NULL,
  block_height     UINTEGER NOT NULL,
  time             TIMESTAMP,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (address, block_height, tx_id)
);

-- Per-block mandatory sidestake payouts. One row per coinstake vout
-- (idx >= 2) whose destination matches the active registry. amount is
-- halford. Per-recipient timeline is the dominant read.
CREATE TABLE IF NOT EXISTS coinstake_sidestakes (
  address        VARCHAR NOT NULL,
  block_height   UINTEGER NOT NULL,
  vout_idx       USMALLINT NOT NULL,
  tx_id          VARCHAR,
  amount         UBIGINT,
  allocation_pct DOUBLE,
  time           TIMESTAMP,
  _ingested_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (address, block_height, vout_idx)
);

-- Per-block snapshot of the active mempool when a block landed.
-- was_included flags txs this block confirmed. Reorg re-ingest upserts.
CREATE TABLE IF NOT EXISTS mempool_snapshots (
  block_height UINTEGER NOT NULL,
  block_hash   VARCHAR,
  block_time   TIMESTAMP,
  captured_at  TIMESTAMP DEFAULT now(),
  tx_id        VARCHAR NOT NULL,
  first_seen   TIMESTAMP,
  fee_estimate UBIGINT,
  size         UINTEGER,
  vin_count    USMALLINT,
  vout_count   USMALLINT,
  was_included BOOLEAN,
  PRIMARY KEY (block_height, tx_id)
);

-- v12+ MRC request transactions. block_height / block_time are NULL
-- while pending in mempool, UPDATEd when the carrying block lands.
CREATE TABLE IF NOT EXISTS mrc_requests (
  tx_id            VARCHAR PRIMARY KEY,
  cpid             VARCHAR,
  client_version   VARCHAR,
  organization     VARCHAR,
  research_subsidy UBIGINT,
  fee_offered      UBIGINT,
  magnitude        DOUBLE,
  magnitude_unit   DOUBLE,
  last_block_hash  VARCHAR,
  pay_to_address   VARCHAR,
  first_seen       TIMESTAMP,
  block_height     UINTEGER,
  block_time       TIMESTAMP,
  version          UTINYINT DEFAULT 1,
  signature        VARCHAR DEFAULT '',
  _ingested_at     TIMESTAMP DEFAULT now()
);

-- Address clusters (common-input-ownership heuristic). Populated by
-- AddressClusterJob (periodic union-find over tx_inputs). cluster_id =
-- lexicographically smallest member. Only multi-member clusters get a
-- row ("no row" = address is its own trivial cluster). The cluster_id
-- index serves the reverse "all members of a cluster" lookup (CH bloom).
CREATE TABLE IF NOT EXISTS address_clusters (
  address      VARCHAR PRIMARY KEY,
  cluster_id   VARCHAR,
  cluster_size UINTEGER,
  _ingested_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_address_clusters_cluster ON address_clusters (cluster_id);
