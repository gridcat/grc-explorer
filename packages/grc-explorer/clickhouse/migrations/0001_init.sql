-- Spine tables for the Gridcoin explorer on ClickHouse. Companion to
-- the architecture decision recorded 2026-05-01 (CH source of truth +
-- Redis projection layer; MySQL retired for the explorer).
--
-- Versioning: any table that may be re-inserted carries a `_seq UInt64`
-- populated from a single Redis INCR counter. ReplacingMergeTree(_seq)
-- merges away older versions; reads use FINAL or argMax(_seq, …) when
-- they need the latest version eagerly. Pure append-only tables stay
-- plain MergeTree.
--
-- Time semantics: `time` / `valid_from_time` / `first_seen` are
-- chain-time and the public time-machine axis (home page only).
-- `_ingested_at` is wall-clock at write — debug/recovery only, never
-- the user-facing time.
--
-- Reorgs: re-index affected heights and bump `_seq`. The new versions
-- supersede old ones at merge time; query-time correctness via FINAL
-- or argMax doesn't wait for merges.

-- Block headers + per-block aggregates the daemon already returns
-- (mint, money_supply). PARTITION BY month keeps the table prunable
-- by chain-time without exploding part counts. ORDER BY (height) gives
-- B-tree-style point lookups; height is monotonic so range scans are
-- almost free.
CREATE TABLE IF NOT EXISTS blocks (
  height        UInt32,
  hash          FixedString(64),
  prev_hash     FixedString(64),
  merkle_root   FixedString(64),
  time          DateTime CODEC(Delta, ZSTD(3)),
  n_version     UInt32,
  difficulty    Decimal(30, 8),
  size          UInt32,
  tx_count      UInt32,
  is_pos        Bool,
  miner_address Nullable(String) CODEC(ZSTD(3)),
  staker_cpid   Nullable(FixedString(32)),
  is_superblock Bool,
  -- Halford. block_subsidy + research_subsidy + fees swept this block.
  mint          UInt64,
  -- Halford. Daemon's `moneySupply` at this block — stored per row so
  -- inflation/wealth charts read directly without summing `mint`.
  money_supply  UInt64,
  _seq          UInt64,
  _ingested_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (height)
SETTINGS index_granularity = 8192;

-- Transactions. ORDER BY (block_height, index_in_blk) gives sorted
-- scans for "txs in block N" — the dominant block-page query — and
-- keeps related rows physically clustered. Point lookup by tx_id
-- short-circuits via the bloom skip index instead of scanning by the
-- ORDER BY tuple.
--
-- hashboinc on legacy (pre-fern) staking txs has been observed at 59KB+,
-- which is why it's `String` (not FixedString) with aggressive ZSTD(6).
-- Compression is the whole reason this column doesn't blow up the table.
CREATE TABLE IF NOT EXISTS transactions (
  tx_id         FixedString(64),
  block_height  UInt32,
  block_hash    FixedString(64),
  time          DateTime CODEC(Delta, ZSTD(3)),
  size          UInt32,
  fee           UInt64,
  vin_count     UInt16,
  vout_count    UInt16,
  total_in      UInt64,
  total_out     UInt64,
  is_coinbase   Bool,
  is_coinstake  Bool,
  index_in_blk  UInt16,
  hashboinc     Nullable(String) CODEC(ZSTD(6)),
  _seq          UInt64,
  _ingested_at  DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX tx_id_bloom tx_id TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (block_height, index_in_blk)
SETTINGS index_granularity = 8192;

-- Outputs. `spent_in_*` is the deferred annotation: row inserted at
-- creation height with NULLs, re-inserted at spend height with values
-- filled in. ReplacingMergeTree(_seq) keeps the spent version.
--
-- ORDER BY (address, …) makes address-page queries sorted scans for
-- free — the dominant read shape on the explorer. Block-creation
-- height is kept for time-machine derivations on home-page widgets
-- (UTXO snapshot at H = `block_height <= H AND (spent_in_height IS
-- NULL OR spent_in_height > H)`).
--
-- Skipping PARTITION for now (per the Phase 1 plan, ~50M rows/year
-- doesn't need it); revisit if the table approaches ~100M rows.
-- `address` is NOT Nullable here even though some scripts (OP_RETURN,
-- anyone-can-spend, exotic multisig) genuinely have no address — CH
-- forbids nullable columns in sort keys, and address is the leading
-- key for the dominant address-page query. Use empty string '' as
-- the no-address sentinel; it compresses to almost nothing in CH.
CREATE TABLE IF NOT EXISTS tx_outputs (
  tx_id            FixedString(64),
  vout_n           UInt16,
  block_height     UInt32,
  value            UInt64,
  address          String CODEC(ZSTD(3)),
  script_type      LowCardinality(String),
  script_hex       String CODEC(ZSTD(6)),
  spent_in_tx      Nullable(FixedString(64)),
  spent_in_vin_n   Nullable(UInt16),
  spent_in_height  Nullable(UInt32),
  _seq             UInt64,
  _ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX address_bloom address TYPE bloom_filter(0.01) GRANULARITY 32,
  INDEX tx_id_bloom tx_id TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (address, block_height, tx_id, vout_n)
SETTINGS index_granularity = 8192;

-- Inputs. Coinbase/coinstake-style inputs have NULL prev_tx; we keep
-- them in the same table for symmetry. `block_height` denormalised
-- from `transactions` so address-history queries don't have to JOIN
-- back. ORDER BY (block_height, …) clusters by chain time.
CREATE TABLE IF NOT EXISTS tx_inputs (
  tx_id        FixedString(64),
  vin_n        UInt16,
  prev_tx      Nullable(FixedString(64)),
  prev_vout    Nullable(UInt16),
  address      Nullable(String) CODEC(ZSTD(3)),
  value        Nullable(UInt64),
  block_height UInt32,
  _seq         UInt64,
  _ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX address_bloom address TYPE bloom_filter(0.01) GRANULARITY 32,
  INDEX prev_tx_bloom prev_tx TYPE bloom_filter(0.01) GRANULARITY 32
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (block_height, tx_id, vin_n)
SETTINGS index_granularity = 8192;

-- Pure event log of address balance changes. One row per
-- (address, block-that-changed-its-balance). Append-only in normal
-- flow; reorg path re-inserts the affected heights with bumped `_seq`.
-- ReplacingMergeTree on `_seq` keeps the post-reorg version.
--
-- Current-state aggregates (running balance + received + sent + tx
-- count, plus first/last seen) live in Redis as the canonical
-- projection — see lib/redis.ts wallet helpers. This table is the
-- source of truth that Redis is rebuilt from on cold start, plus the
-- only path for time-machine "balance at height H" reads.
CREATE TABLE IF NOT EXISTS address_balance_history (
  address           String CODEC(ZSTD(3)),
  valid_from_height UInt32,
  valid_from_time   DateTime CODEC(Delta, ZSTD(3)),
  delta             Int64,
  received          UInt64,
  sent              UInt64,
  tx_count_delta    UInt32,
  _seq              UInt64,
  _ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
ORDER BY (address, valid_from_height)
SETTINGS index_granularity = 8192;

-- Live network telemetry. NetworkStatsPoller writes one row per tick
-- (~15s). TTL keeps the table at a 7-day rolling window mirroring the
-- existing MySQL behaviour — the dashboard sparklines only need the
-- last hour, the buffer is for SSE catch-up after disconnects.
-- Pure append-only — no `_seq`, plain MergeTree.
CREATE TABLE IF NOT EXISTS network_snapshots (
  ts           DateTime CODEC(Delta, ZSTD(3)),
  peer_count   UInt32,
  mempool_size UInt32,
  difficulty   Decimal(30, 8),
  tip_height   UInt32,
  _ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (ts)
TTL ts + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- Mempool history. Rows live forever — confirmation/eviction stamp
-- the existing row via `_seq` re-insert rather than DELETE, preserving
-- the time-travel record of "what was pending when". The current home-
-- page widgets only need the active slice (`confirmed_at IS NULL AND
-- evicted_at IS NULL`), which is a cheap filter at the top of the
-- ORDER BY tuple.
CREATE TABLE IF NOT EXISTS mempool_txs (
  tx_id        FixedString(64),
  first_seen   DateTime CODEC(Delta, ZSTD(3)),
  fee_estimate UInt64,
  size         UInt32,
  vin_count    UInt16,
  vout_count   UInt16,
  raw_json     String CODEC(ZSTD(6)),
  confirmed_at Nullable(DateTime),
  evicted_at   Nullable(DateTime),
  _seq         UInt64,
  _ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(first_seen)
ORDER BY (tx_id)
SETTINGS index_granularity = 8192;

-- User-supplied MESSAGE-contract payloads. Token bloom filter on the
-- message body lets `WHERE positionCaseInsensitive(message, 'foo') > 0`
-- short-circuit at the granule level without touching Meili — useful
-- for the lightweight "any message containing X" lookups; full-text
-- still goes through Meili.
CREATE TABLE IF NOT EXISTS tx_messages (
  tx_id          FixedString(64),
  block_height   UInt32,
  time           DateTime CODEC(Delta, ZSTD(3)),
  sender_address Nullable(String) CODEC(ZSTD(3)),
  message        String CODEC(ZSTD(6)),
  _seq           UInt64,
  _ingested_at   DateTime64(3, 'UTC') DEFAULT now64(3),

  INDEX sender_bloom sender_address TYPE bloom_filter(0.01) GRANULARITY 32,
  INDEX message_token message TYPE tokenbf_v1(2048, 4, 0) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(_seq)
PARTITION BY toYYYYMM(time)
ORDER BY (tx_id)
SETTINGS index_granularity = 8192;

-- Migration metadata. Tiny table — purely append-only audit of which
-- migration files have been applied. The runner (`clickhouse/migrate.ts`)
-- inserts a row after each successful file, refusing to re-apply.
CREATE TABLE IF NOT EXISTS _migrations (
  name        String,
  applied_at  DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (applied_at);
