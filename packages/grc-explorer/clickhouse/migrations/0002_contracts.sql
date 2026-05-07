-- Gridcoin contract data: claims, beacons, superblocks, polls/votes,
-- wealth snapshots. All extracted by ContractParser from the daemon's
-- per-tx contract payloads. Same `_seq` discipline as 0001 — re-extract
-- on reorg with a bumped sequence; ReplacingMergeTree picks the latest.
--
-- Polls and votes are stored canonically here (CH = source of truth);
-- the active-polls list, per-poll vote tally, and other read-shaped
-- views live as Redis projections that are rebuildable from these
-- tables on demand.

-- Per-block staking claim. `block_height` is the natural key — every
-- staking block has exactly one claim row.
CREATE TABLE IF NOT EXISTS claims (
  block_height     UInt32,
  cpid             Nullable(FixedString(32)),
  mining_id        FixedString(32),
  client_version   String CODEC(ZSTD(3)),
  organization     String CODEC(ZSTD(3)),
  block_subsidy    UInt64,
  research_subsidy UInt64,
  magnitude        Float64,
  magnitude_unit   Float64,
  quorum_hash      Nullable(FixedString(64)),
  quorum_address   Nullable(String),
  signature        String CODEC(ZSTD(6)),
  is_mrc           Bool,
  mrc_tx_map_size  UInt32,
  _seq             UInt64,
  _ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX cpid_bloom cpid TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (block_height)
SETTINGS index_granularity = 8192;

-- v12+ Mandatory Research Claim payouts. One row per (block, cpid)
-- — alongside the staker's own claim above, captures the extra
-- researchers paid in the same block. Without this table, "research
-- paid out by block H" would silently undercount on every MRC block
-- (often 10-100×).
CREATE TABLE IF NOT EXISTS claim_mrcs (
  block_height     UInt32,
  cpid             FixedString(32),
  mining_id        FixedString(32),
  client_version   String CODEC(ZSTD(3)),
  research_subsidy UInt64,
  magnitude        Float64,
  pay_to_address   Nullable(String),
  _seq             UInt64,
  _ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (block_height, cpid)
SETTINGS index_granularity = 8192;

-- Superblock contracts. One row per superblock height; details fan
-- out into superblock_magnitudes and superblock_projects below.
CREATE TABLE IF NOT EXISTS superblocks (
  height          UInt32,
  quorum_hash     FixedString(64),
  total_magnitude Float64,
  cpid_count      UInt32,
  project_count   UInt32,
  payload_size    UInt32,
  _seq            UInt64,
  _ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (height)
SETTINGS index_granularity = 8192;

-- Per-CPID magnitude in a given superblock. ORDER BY (cpid, height)
-- gives sorted-scan magnitude time-series for "show me CPID X over
-- time" — the dominant CPID-page query — at the cost of slightly
-- larger parts when joined back to superblocks. Worth it.
CREATE TABLE IF NOT EXISTS superblock_magnitudes (
  superblock_height UInt32,
  cpid              FixedString(32),
  magnitude         Float64,
  _seq              UInt64,
  _ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (cpid, superblock_height)
SETTINGS index_granularity = 8192;

-- Per-project RAC/credit breakdown. Project-name is small-cardinality
-- (~50-100 BOINC projects ever); LowCardinality cuts storage and lets
-- WHERE project_name = … be a dictionary lookup.
CREATE TABLE IF NOT EXISTS superblock_projects (
  superblock_height UInt32,
  project_name      LowCardinality(String),
  average_rac       Float64,
  rac               Float64,
  total_credit      Float64,
  _seq              UInt64,
  _ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (project_name, superblock_height)
SETTINGS index_granularity = 8192;

-- Beacons. `superseded_at_height` is the deferred annotation: set
-- when a newer beacon for the same CPID lands. Active beacons at H =
-- `block_height <= H AND (superseded_at_height IS NULL OR
-- superseded_at_height > H)` plus the existing expiration-time check.
CREATE TABLE IF NOT EXISTS beacons (
  cpid                 FixedString(32),
  address              String CODEC(ZSTD(3)),
  status               LowCardinality(String),
  tx_id                FixedString(64),
  block_height         UInt32,
  timestamp            DateTime CODEC(Delta, ZSTD(3)),
  expiration           DateTime CODEC(Delta, ZSTD(3)),
  superseded_at_height Nullable(UInt32),
  _seq                 UInt64,
  _ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX address_bloom address TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (cpid, block_height, tx_id)
SETTINGS index_granularity = 8192;

-- Polls. Several columns get filled in deferred (av_w_*, weight_*) by
-- PollWeightAggregator after the poll closes; ReplacingMergeTree picks
-- up the post-aggregation row. The Redis projection (`poll:{id}` HSET,
-- `polls:by_end_time` ZSET, etc.) is rebuilt from this table.
CREATE TABLE IF NOT EXISTS polls (
  poll_id                    FixedString(64),
  title                      String CODEC(ZSTD(3)),
  question                   String CODEC(ZSTD(6)),
  url                        Nullable(String),
  poll_type                  LowCardinality(Nullable(String)),
  response_type              LowCardinality(String),
  weight_type                LowCardinality(String),
  start_time                 DateTime CODEC(Delta, ZSTD(3)),
  end_time                   DateTime CODEC(Delta, ZSTD(3)),
  claim_tx                   FixedString(64),
  block_height               UInt32,
  creator_address            Nullable(String),
  magnitude_weight_factor    Nullable(Float64),
  -- Halford. Cached AV-W components, populated when the poll ends.
  av_w_balance               Nullable(UInt64),
  av_w_magnitude             Nullable(Float64),
  -- Sentinel: when this matches block_height the aggregator has run
  -- and av_w_* / votes.weight_* are authoritative.
  weights_computed_at_height Nullable(UInt32),
  _seq                       UInt64,
  _ingested_at               DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (poll_id)
SETTINGS index_granularity = 8192;

-- Poll choice options.
CREATE TABLE IF NOT EXISTS poll_options (
  poll_id FixedString(64),
  idx     UInt16,
  label   String CODEC(ZSTD(3)),
  _seq    UInt64,
  _ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (poll_id, idx)
SETTINGS index_granularity = 8192;

-- Votes. weight/weight_balance/weight_magnitude get filled in by the
-- aggregator after the poll closes — same deferred-annotation pattern
-- as polls itself. Natural identity is (tx_id, choice_idx) since one
-- vote tx can contain multiple choices in multi-choice polls.
CREATE TABLE IF NOT EXISTS votes (
  poll_id           FixedString(64),
  voter_address     String CODEC(ZSTD(3)),
  voter_cpid        Nullable(FixedString(32)),
  mining_id         Nullable(FixedString(64)),
  choice_idx        UInt16,
  weight            UInt64,
  weight_balance    UInt64 DEFAULT 0,
  weight_magnitude  Float64 DEFAULT 0,
  tx_id             FixedString(64),
  block_height      UInt32,
  _seq              UInt64,
  _ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX voter_addr_bloom voter_address TYPE bloom_filter(0.01) GRANULARITY 32,
  INDEX voter_cpid_bloom voter_cpid TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (poll_id, tx_id, choice_idx)
SETTINGS index_granularity = 8192;

-- Periodic chain-level wealth snapshot. WealthSnapshotJob writes one
-- row per snapshot interval (1d default). Pure append-only — once
-- written, never updated. Powers the wealth-distribution dashboard.
CREATE TABLE IF NOT EXISTS wealth_snapshots (
  bucket_ts              DateTime CODEC(Delta, ZSTD(3)),
  total_supply           UInt64,
  addresses_with_balance UInt32,
  gini                   Decimal(10, 8),
  top1pct_share          Decimal(10, 8),
  top10pct_share         Decimal(10, 8),
  top100_share           Decimal(10, 8),
  active_24h             UInt32,
  new_24h                UInt32,
  hodler_30d             UInt32,
  hodler_180d            UInt32,
  _ingested_at           DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY (bucket_ts)
SETTINGS index_granularity = 8192;
