-- Gridcoin contract data: claims, MRCs, superblocks, beacons,
-- polls/votes, wealth snapshots. Extracted by ContractParser from the
-- daemon's per-tx contract payloads. Squashed from CH migrations
-- 0002 / 0004 (claims.block_time) / 0012 (mrc fees) / 0020 (superblock
-- contract_version) / 0021 (beacon auth_method) / 0026 (claim signature,
-- magnitude_unit) into final shape. _seq dropped; PK + upsert instead.
-- Polls/votes weights and beacons.superseded_at_height are deferred
-- annotations, now plain UPDATEs.

-- Per-block staking claim. block_height is the natural key — one claim
-- row per staking block. block_time (denormalised from blocks) drives
-- the claims rollup views; mrc_*_fees split the MRC bid fees.
CREATE TABLE IF NOT EXISTS claims (
  block_height        UINTEGER PRIMARY KEY,
  cpid                VARCHAR,
  mining_id           VARCHAR,
  client_version      VARCHAR,
  organization        VARCHAR,
  block_subsidy       UBIGINT,
  research_subsidy    UBIGINT,
  magnitude           DOUBLE,
  magnitude_unit      DOUBLE,
  quorum_hash         VARCHAR,
  quorum_address      VARCHAR,
  signature           VARCHAR DEFAULT '',
  is_mrc              BOOLEAN,
  mrc_tx_map_size     UINTEGER,
  block_time          TIMESTAMP,
  mrc_foundation_fees UBIGINT DEFAULT 0,
  mrc_staker_fees     UBIGINT DEFAULT 0,
  _ingested_at        TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_cpid ON claims (cpid);

-- v12+ Mandatory Research Claim payouts. One row per (block, cpid) for
-- the extra researchers paid alongside the staker's own claim.
CREATE TABLE IF NOT EXISTS claim_mrcs (
  block_height     UINTEGER NOT NULL,
  cpid             VARCHAR NOT NULL,
  mining_id        VARCHAR,
  client_version   VARCHAR,
  research_subsidy UBIGINT,
  magnitude        DOUBLE,
  pay_to_address   VARCHAR,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (block_height, cpid)
);

-- Superblock contracts. contract_version (0020): v3 (at V13) carries
-- per-project all-CPID total_credit; 0 = indexed before we tracked it.
CREATE TABLE IF NOT EXISTS superblocks (
  height           UINTEGER PRIMARY KEY,
  quorum_hash      VARCHAR,
  total_magnitude  DOUBLE,
  cpid_count       UINTEGER,
  project_count    UINTEGER,
  payload_size     UINTEGER,
  contract_version UTINYINT DEFAULT 0,
  _ingested_at     TIMESTAMP DEFAULT now()
);

-- Per-CPID magnitude in a superblock. PK (cpid, superblock_height) keeps
-- the per-CPID magnitude time-series an index range scan; the
-- superblock_height index serves the per-superblock detail page (CH's
-- proj_by_superblock_height).
CREATE TABLE IF NOT EXISTS superblock_magnitudes (
  superblock_height UINTEGER NOT NULL,
  cpid              VARCHAR NOT NULL,
  magnitude         DOUBLE,
  _ingested_at      TIMESTAMP DEFAULT now(),
  PRIMARY KEY (cpid, superblock_height)
);
CREATE INDEX IF NOT EXISTS idx_superblock_magnitudes_height ON superblock_magnitudes (superblock_height);

-- Per-project RAC/credit breakdown in a superblock.
CREATE TABLE IF NOT EXISTS superblock_projects (
  superblock_height UINTEGER NOT NULL,
  project_name      VARCHAR NOT NULL,
  average_rac       DOUBLE,
  rac               DOUBLE,
  total_credit      DOUBLE,
  _ingested_at      TIMESTAMP DEFAULT now(),
  PRIMARY KEY (superblock_height, project_name)
);
CREATE INDEX IF NOT EXISTS idx_superblock_projects_name ON superblock_projects (project_name);

-- Beacons. superseded_at_height is the deferred annotation (UPDATEd when
-- a newer beacon for the same CPID lands). auth_method (0021): legacy /
-- v2_email_verify / v3_boinc_signed; '' = unknown (pre-column rows).
CREATE TABLE IF NOT EXISTS beacons (
  cpid                 VARCHAR NOT NULL,
  address              VARCHAR,
  status               VARCHAR,
  tx_id                VARCHAR NOT NULL,
  block_height         UINTEGER NOT NULL,
  timestamp            TIMESTAMP,
  expiration           TIMESTAMP,
  superseded_at_height UINTEGER,
  auth_method          VARCHAR DEFAULT '',
  _ingested_at         TIMESTAMP DEFAULT now(),
  PRIMARY KEY (cpid, block_height, tx_id)
);
CREATE INDEX IF NOT EXISTS idx_beacons_address ON beacons (address);

-- Polls. av_w_* / weight_* columns are filled in deferred by
-- PollWeightAggregator after the poll closes (UPDATE). weights_computed_
-- at_height == block_height is the "aggregator has run" sentinel.
CREATE TABLE IF NOT EXISTS polls (
  poll_id                    VARCHAR PRIMARY KEY,
  title                      VARCHAR,
  question                   VARCHAR,
  url                        VARCHAR,
  poll_type                  VARCHAR,
  response_type              VARCHAR,
  weight_type                VARCHAR,
  start_time                 TIMESTAMP,
  end_time                   TIMESTAMP,
  claim_tx                   VARCHAR,
  block_height               UINTEGER,
  creator_address            VARCHAR,
  magnitude_weight_factor    DOUBLE,
  -- Halford. Cached AV-W components, populated when the poll ends.
  av_w_balance               UBIGINT,
  av_w_magnitude             DOUBLE,
  weights_computed_at_height UINTEGER,
  _ingested_at               TIMESTAMP DEFAULT now()
);

-- Poll choice options.
CREATE TABLE IF NOT EXISTS poll_options (
  poll_id      VARCHAR NOT NULL,
  idx          USMALLINT NOT NULL,
  label        VARCHAR,
  _ingested_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (poll_id, idx)
);

-- Votes. weight* filled in by the aggregator after close (UPDATE).
-- Natural identity is (tx_id, choice_idx) — one vote tx can carry
-- multiple choices. poll_id index serves the per-poll tally.
CREATE TABLE IF NOT EXISTS votes (
  poll_id          VARCHAR NOT NULL,
  voter_address    VARCHAR,
  voter_cpid       VARCHAR,
  mining_id        VARCHAR,
  choice_idx       USMALLINT NOT NULL,
  weight           UBIGINT,
  weight_balance   UBIGINT DEFAULT 0,
  weight_magnitude DOUBLE DEFAULT 0,
  tx_id            VARCHAR NOT NULL,
  block_height     UINTEGER,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (tx_id, choice_idx)
);
CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes (poll_id);

-- Periodic chain-level wealth snapshot (1d default). Append-only — one
-- row per snapshot interval. Powers the wealth-distribution dashboard.
CREATE TABLE IF NOT EXISTS wealth_snapshots (
  bucket_ts              TIMESTAMP PRIMARY KEY,
  total_supply           UBIGINT,
  addresses_with_balance UINTEGER,
  gini                   DECIMAL(10, 8),
  top1pct_share          DECIMAL(10, 8),
  top10pct_share         DECIMAL(10, 8),
  top100_share           DECIMAL(10, 8),
  active_24h             UINTEGER,
  new_24h                UINTEGER,
  hodler_30d             UINTEGER,
  hodler_180d            UINTEGER,
  _ingested_at           TIMESTAMP DEFAULT now()
);
