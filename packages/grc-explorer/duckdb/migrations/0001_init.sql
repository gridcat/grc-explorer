-- Spine tables for the Gridcoin explorer on DuckDB. Squashed from the
-- ClickHouse schema (clickhouse/migrations/0001–0036) during the 2026-06
-- CH→DuckDB migration. Because production was reset (no data to
-- preserve), the 36 incremental CH migrations are folded into a clean
-- final-state schema across four files:
--   0001 spine tables (this file)   0003 projects / protocol / mrc / clusters
--   0002 contract tables            0004 rollup views (replace the CH MVs)
--
-- Versioning: ClickHouse used ReplacingMergeTree(_seq) + a Redis INCR
-- counter to dedup re-inserts at merge time. DuckDB has real primary
-- keys and upserts, so every re-writable table carries a PRIMARY KEY on
-- its natural identity and the writer uses `INSERT … ON CONFLICT (<pk>)
-- DO UPDATE`. The `_seq` column and its Redis counter are gone — no
-- merge lag, no FINAL/argMax at read time.
--
-- Deferred annotations (tx_outputs.spent_*, beacons.superseded_at_height,
-- polls/votes weights, mrc_requests.block_*) were re-inserts under
-- ReplacingMergeTree; in DuckDB they are plain UPDATEs.
--
-- DuckDB notes: nullable-by-default (PK columns are implicitly NOT NULL);
-- no PARTITION BY / CODEC / LowCardinality (row-groups + automatic
-- compression + dictionary encoding cover those); CH bloom skip-indexes
-- and projections become ART indexes via CREATE INDEX where a non-PK
-- lookup is hot; CH materialized views become DuckDB views (0004).
-- Types: UInt8→UTINYINT, UInt16→USMALLINT, UInt32→UINTEGER,
-- UInt64→UBIGINT, Int64→BIGINT, Float64→DOUBLE, Decimal→DECIMAL,
-- DateTime→TIMESTAMP, FixedString/String→VARCHAR.

-- Block headers + per-block aggregates. difficulty is DOUBLE (CH 0013
-- widened Decimal→Float64 because late-mainnet/legacy values overflow a
-- 30,8 decimal). nonce/bits are the raw PoW header fields (0023).
CREATE TABLE IF NOT EXISTS blocks (
  height        UINTEGER PRIMARY KEY,
  hash          VARCHAR NOT NULL,
  prev_hash     VARCHAR NOT NULL,
  merkle_root   VARCHAR NOT NULL,
  time          TIMESTAMP NOT NULL,
  n_version     UINTEGER,
  difficulty    DOUBLE,
  size          UINTEGER,
  tx_count      UINTEGER,
  is_pos        BOOLEAN,
  miner_address VARCHAR,
  staker_cpid   VARCHAR,
  is_superblock BOOLEAN,
  -- Halford. block_subsidy + research_subsidy + fees swept this block.
  mint          UBIGINT,
  -- Halford. Daemon's moneySupply at this block.
  money_supply  UBIGINT,
  nonce         UINTEGER DEFAULT 0,
  bits          VARCHAR DEFAULT '00000000',
  _ingested_at  TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks (hash);
CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks (time);

-- Transactions. n_version / n_lock_time (0024) support V14 BIP68/BIP65
-- validation reconstruction. hashboinc on legacy staking txs reaches
-- 59KB+ (DuckDB compresses it).
CREATE TABLE IF NOT EXISTS transactions (
  tx_id         VARCHAR PRIMARY KEY,
  block_height  UINTEGER NOT NULL,
  block_hash    VARCHAR NOT NULL,
  time          TIMESTAMP NOT NULL,
  size          UINTEGER,
  fee           UBIGINT,
  vin_count     USMALLINT,
  vout_count    USMALLINT,
  total_in      UBIGINT,
  total_out     UBIGINT,
  is_coinbase   BOOLEAN,
  is_coinstake  BOOLEAN,
  index_in_blk  USMALLINT,
  hashboinc     VARCHAR,
  n_version     UINTEGER DEFAULT 1,
  n_lock_time   UINTEGER DEFAULT 0,
  _ingested_at  TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_block ON transactions (block_height, index_in_blk);

-- Outputs. spent_in_* is the deferred annotation (UPDATEd at spend
-- height). address is NOT NULL with '' as the no-address sentinel
-- (OP_RETURN / anyone-can-spend / exotic multisig), matching the CH
-- convention the read path expects. req_sigs (0025) = multisig
-- threshold. PK (tx_id, vout_n) also serves the (tx_id, vout_n) point
-- lookups CH covered with proj_by_outpoint.
CREATE TABLE IF NOT EXISTS tx_outputs (
  tx_id            VARCHAR NOT NULL,
  vout_n           USMALLINT NOT NULL,
  block_height     UINTEGER NOT NULL,
  value            UBIGINT,
  address          VARCHAR NOT NULL DEFAULT '',
  script_type      VARCHAR,
  script_hex       VARCHAR,
  spent_in_tx      VARCHAR,
  spent_in_vin_n   USMALLINT,
  spent_in_height  UINTEGER,
  req_sigs         UTINYINT DEFAULT 0,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (tx_id, vout_n)
);
CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs (address, block_height);

-- Inputs. Coinbase/coinstake inputs have NULL prev_tx. block_height is
-- denormalised from transactions. is_phantom_spend (0016) flags
-- re-claims of an already-spent UTXO (Halford-era coinstake bug).
-- script_sig_hex / sequence (0022) support HTLC + BIP68 detection.
-- Indexes mirror the CH blooms (address, prev_tx, tx_id) and the
-- proj_by_prevout projection (prev_tx, prev_vout) for spend-status reads.
CREATE TABLE IF NOT EXISTS tx_inputs (
  tx_id            VARCHAR NOT NULL,
  vin_n            USMALLINT NOT NULL,
  prev_tx          VARCHAR,
  prev_vout        USMALLINT,
  address          VARCHAR,
  value            UBIGINT,
  block_height     UINTEGER NOT NULL,
  is_phantom_spend BOOLEAN DEFAULT false,
  script_sig_hex   VARCHAR DEFAULT '',
  sequence         UINTEGER DEFAULT 4294967295,
  _ingested_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (tx_id, vin_n)
);
CREATE INDEX IF NOT EXISTS idx_tx_inputs_address ON tx_inputs (address);
CREATE INDEX IF NOT EXISTS idx_tx_inputs_prevout ON tx_inputs (prev_tx, prev_vout);
CREATE INDEX IF NOT EXISTS idx_tx_inputs_block ON tx_inputs (block_height);

-- Address balance-change event log: one row per (address, block that
-- changed its balance). Reorg path upserts affected heights. Current-
-- state aggregates live in Redis (rebuilt from this table on cold
-- start); this table is also the only path for time-machine "balance at
-- height H" reads. received/sent net coinstake principal (0036).
CREATE TABLE IF NOT EXISTS address_balance_history (
  address           VARCHAR NOT NULL,
  valid_from_height UINTEGER NOT NULL,
  valid_from_time   TIMESTAMP NOT NULL,
  delta             BIGINT,
  received          UBIGINT,
  sent              UBIGINT,
  tx_count_delta    UINTEGER,
  _ingested_at      TIMESTAMP DEFAULT now(),
  PRIMARY KEY (address, valid_from_height)
);

-- Live network telemetry (~15s tick). CH kept a 7-day window via TTL;
-- DuckDB has no TTL, so a periodic DELETE job prunes old rows. difficulty
-- is DOUBLE (0013). Append-only.
CREATE TABLE IF NOT EXISTS network_snapshots (
  ts           TIMESTAMP NOT NULL,
  peer_count   UINTEGER,
  mempool_size UINTEGER,
  difficulty   DOUBLE,
  tip_height   UINTEGER,
  _ingested_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_snapshots_ts ON network_snapshots (ts);

-- Mempool history. confirmation/eviction UPDATEs the row rather than
-- deleting, preserving "what was pending when". Active slice =
-- confirmed_at IS NULL AND evicted_at IS NULL.
CREATE TABLE IF NOT EXISTS mempool_txs (
  tx_id        VARCHAR PRIMARY KEY,
  first_seen   TIMESTAMP NOT NULL,
  fee_estimate UBIGINT,
  size         UINTEGER,
  vin_count    USMALLINT,
  vout_count   USMALLINT,
  raw_json     VARCHAR,
  confirmed_at TIMESTAMP,
  evicted_at   TIMESTAMP,
  _ingested_at TIMESTAMP DEFAULT now()
);

-- User-supplied MESSAGE-contract payloads. Full-text search goes through
-- Meili; substring probes are a plain scan (CH's token bloom dropped).
CREATE TABLE IF NOT EXISTS tx_messages (
  tx_id          VARCHAR PRIMARY KEY,
  block_height   UINTEGER NOT NULL,
  time           TIMESTAMP NOT NULL,
  sender_address VARCHAR,
  message        VARCHAR,
  _ingested_at   TIMESTAMP DEFAULT now()
);
