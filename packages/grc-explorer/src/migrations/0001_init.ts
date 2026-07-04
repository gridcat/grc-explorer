import { Kysely, sql } from 'kysely';

// Initial MariaDB schema for the explorer — ported from the DuckDB
// migrations (duckdb/migrations/0001_init, 0002_contracts,
// 0003_projects_protocol, + 0006 claim_mrcs.fee), squashed into one
// clean final state. Raw SQL (not the Kysely schema builder) is used
// deliberately: it ports the 26-table DDL near-verbatim, so the column
// set / types / indexes stay auditable against the DuckDB source.
//
// Type translation: UINTEGER→INT UNSIGNED, UBIGINT→BIGINT UNSIGNED,
// USMALLINT→SMALLINT UNSIGNED, UTINYINT→TINYINT UNSIGNED, BIGINT (signed,
// `delta`) stays BIGINT, DOUBLE→DOUBLE, DECIMAL(10,8) kept, TIMESTAMP→
// DATETIME, BOOLEAN→TINYINT(1), now()→CURRENT_TIMESTAMP. Unbounded DuckDB
// VARCHAR becomes a sized VARCHAR where it's a key/lookup (hashes 64,
// cpids 32, addresses 64, project/protocol keys 255) or TEXT/MEDIUMTEXT
// where it holds large free content (poll title/question/url, option
// label, hashboinc, raw_json, scripts, messages). Every table is
// utf8mb4 / ROW_FORMAT=DYNAMIC so the 3072-byte index-prefix ceiling
// covers the composite PKs.
//
// Index changes vs DuckDB: `idx_votes_poll` is RESTORED (DuckDB dropped
// it in 0005 to dodge an ART-index bug InnoDB doesn't have), and
// `idx_blocks_staker_cpid` + `idx_mrc_requests_cpid` +
// `idx_mrc_requests_block_time` are ADDED to back read paths DuckDB
// served with full scans.

const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC';

export async function up(db: Kysely<unknown>): Promise<void> {
  // ---- Spine tables (DuckDB 0001) ----

  await sql`
    CREATE TABLE blocks (
      height        INT UNSIGNED PRIMARY KEY,
      hash          VARCHAR(64) NOT NULL,
      prev_hash     VARCHAR(64) NOT NULL,
      merkle_root   VARCHAR(64) NOT NULL,
      time          DATETIME NOT NULL,
      n_version     INT UNSIGNED,
      difficulty    DOUBLE,
      size          INT UNSIGNED,
      tx_count      INT UNSIGNED,
      is_pos        TINYINT(1),
      miner_address VARCHAR(64),
      staker_cpid   VARCHAR(32),
      is_superblock TINYINT(1),
      mint          BIGINT UNSIGNED,
      money_supply  BIGINT UNSIGNED,
      nonce         INT UNSIGNED DEFAULT 0,
      bits          VARCHAR(16) DEFAULT '00000000',
      _ingested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY idx_blocks_hash (hash),
      KEY idx_blocks_time (time),
      KEY idx_blocks_staker_cpid (staker_cpid)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE transactions (
      tx_id         VARCHAR(64) PRIMARY KEY,
      block_height  INT UNSIGNED NOT NULL,
      block_hash    VARCHAR(64) NOT NULL,
      time          DATETIME NOT NULL,
      size          INT UNSIGNED,
      fee           BIGINT UNSIGNED,
      vin_count     SMALLINT UNSIGNED,
      vout_count    SMALLINT UNSIGNED,
      total_in      BIGINT UNSIGNED,
      total_out     BIGINT UNSIGNED,
      is_coinbase   TINYINT(1),
      is_coinstake  TINYINT(1),
      index_in_blk  SMALLINT UNSIGNED,
      hashboinc     MEDIUMTEXT,
      n_version     INT UNSIGNED DEFAULT 1,
      n_lock_time   INT UNSIGNED DEFAULT 0,
      _ingested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_transactions_block (block_height, index_in_blk)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE tx_outputs (
      tx_id            VARCHAR(64) NOT NULL,
      vout_n           SMALLINT UNSIGNED NOT NULL,
      block_height     INT UNSIGNED NOT NULL,
      value            BIGINT UNSIGNED,
      address          VARCHAR(64) NOT NULL DEFAULT '',
      script_type      VARCHAR(32),
      script_hex       TEXT,
      spent_in_tx      VARCHAR(64),
      spent_in_vin_n   SMALLINT UNSIGNED,
      spent_in_height  INT UNSIGNED,
      req_sigs         TINYINT UNSIGNED DEFAULT 0,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tx_id, vout_n),
      KEY idx_tx_outputs_address (address, block_height)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE tx_inputs (
      tx_id            VARCHAR(64) NOT NULL,
      vin_n            SMALLINT UNSIGNED NOT NULL,
      prev_tx          VARCHAR(64),
      prev_vout        SMALLINT UNSIGNED,
      address          VARCHAR(64),
      value            BIGINT UNSIGNED,
      block_height     INT UNSIGNED NOT NULL,
      is_phantom_spend TINYINT(1) DEFAULT 0,
      script_sig_hex   TEXT,
      \`sequence\`       INT UNSIGNED DEFAULT 4294967295,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tx_id, vin_n),
      KEY idx_tx_inputs_address (address),
      KEY idx_tx_inputs_prevout (prev_tx, prev_vout),
      KEY idx_tx_inputs_block (block_height)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE address_balance_history (
      address           VARCHAR(64) NOT NULL,
      valid_from_height INT UNSIGNED NOT NULL,
      valid_from_time   DATETIME NOT NULL,
      delta             BIGINT,
      received          BIGINT UNSIGNED,
      sent              BIGINT UNSIGNED,
      tx_count_delta    INT UNSIGNED,
      _ingested_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (address, valid_from_height)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE network_snapshots (
      ts           DATETIME NOT NULL,
      peer_count   INT UNSIGNED,
      mempool_size INT UNSIGNED,
      difficulty   DOUBLE,
      tip_height   INT UNSIGNED,
      _ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_network_snapshots_ts (ts)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE mempool_txs (
      tx_id        VARCHAR(64) PRIMARY KEY,
      first_seen   DATETIME NOT NULL,
      fee_estimate BIGINT UNSIGNED,
      size         INT UNSIGNED,
      vin_count    SMALLINT UNSIGNED,
      vout_count   SMALLINT UNSIGNED,
      raw_json     LONGTEXT,
      confirmed_at DATETIME,
      evicted_at   DATETIME,
      _ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE tx_messages (
      tx_id          VARCHAR(64) PRIMARY KEY,
      block_height   INT UNSIGNED NOT NULL,
      time           DATETIME NOT NULL,
      sender_address VARCHAR(64),
      message        TEXT,
      _ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ${sql.raw(T)}
  `.execute(db);

  // ---- Contract tables (DuckDB 0002 + 0006 claim_mrcs.fee) ----

  await sql`
    CREATE TABLE claims (
      block_height        INT UNSIGNED PRIMARY KEY,
      cpid                VARCHAR(32),
      mining_id           VARCHAR(64),
      client_version      VARCHAR(64),
      organization        VARCHAR(255),
      block_subsidy       BIGINT UNSIGNED,
      research_subsidy    BIGINT UNSIGNED,
      magnitude           DOUBLE,
      magnitude_unit      DOUBLE,
      quorum_hash         VARCHAR(64),
      quorum_address      VARCHAR(64),
      signature           VARCHAR(255) DEFAULT '',
      is_mrc              TINYINT(1),
      mrc_tx_map_size     INT UNSIGNED,
      block_time          DATETIME,
      mrc_foundation_fees BIGINT UNSIGNED DEFAULT 0,
      mrc_staker_fees     BIGINT UNSIGNED DEFAULT 0,
      _ingested_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_claims_cpid (cpid)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE claim_mrcs (
      block_height     INT UNSIGNED NOT NULL,
      cpid             VARCHAR(32) NOT NULL,
      mining_id        VARCHAR(64),
      client_version   VARCHAR(64),
      research_subsidy BIGINT UNSIGNED,
      magnitude        DOUBLE,
      pay_to_address   VARCHAR(64),
      fee              BIGINT UNSIGNED,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (block_height, cpid)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE superblocks (
      height           INT UNSIGNED PRIMARY KEY,
      quorum_hash      VARCHAR(64),
      total_magnitude  DOUBLE,
      cpid_count       INT UNSIGNED,
      project_count    INT UNSIGNED,
      payload_size     INT UNSIGNED,
      contract_version TINYINT UNSIGNED DEFAULT 0,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE superblock_magnitudes (
      superblock_height INT UNSIGNED NOT NULL,
      cpid              VARCHAR(32) NOT NULL,
      magnitude         DOUBLE,
      _ingested_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cpid, superblock_height),
      KEY idx_superblock_magnitudes_height (superblock_height)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE superblock_projects (
      superblock_height INT UNSIGNED NOT NULL,
      project_name      VARCHAR(255) NOT NULL,
      average_rac       DOUBLE,
      rac               DOUBLE,
      total_credit      DOUBLE,
      _ingested_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (superblock_height, project_name),
      KEY idx_superblock_projects_name (project_name)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE beacons (
      cpid                 VARCHAR(32) NOT NULL,
      address              VARCHAR(64),
      status               VARCHAR(32),
      tx_id                VARCHAR(64) NOT NULL,
      block_height         INT UNSIGNED NOT NULL,
      \`timestamp\`         DATETIME,
      expiration           DATETIME,
      superseded_at_height INT UNSIGNED,
      auth_method          VARCHAR(32) DEFAULT '',
      _ingested_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cpid, block_height, tx_id),
      KEY idx_beacons_address (address)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE polls (
      poll_id                    VARCHAR(64) PRIMARY KEY,
      title                      MEDIUMTEXT,
      question                   MEDIUMTEXT,
      url                        MEDIUMTEXT,
      poll_type                  VARCHAR(32),
      response_type              VARCHAR(32),
      weight_type                VARCHAR(32),
      start_time                 DATETIME,
      end_time                   DATETIME,
      claim_tx                   VARCHAR(64),
      block_height               INT UNSIGNED,
      creator_address            VARCHAR(64),
      magnitude_weight_factor    DOUBLE,
      av_w_balance               BIGINT UNSIGNED,
      av_w_magnitude             DOUBLE,
      weights_computed_at_height INT UNSIGNED,
      _ingested_at               DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE poll_options (
      poll_id      VARCHAR(64) NOT NULL,
      idx          SMALLINT UNSIGNED NOT NULL,
      label        MEDIUMTEXT,
      _ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (poll_id, idx)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE votes (
      poll_id          VARCHAR(64) NOT NULL,
      voter_address    VARCHAR(64),
      voter_cpid       VARCHAR(32),
      mining_id        VARCHAR(64),
      choice_idx       SMALLINT UNSIGNED NOT NULL,
      weight           BIGINT UNSIGNED,
      weight_balance   BIGINT UNSIGNED DEFAULT 0,
      weight_magnitude DOUBLE DEFAULT 0,
      tx_id            VARCHAR(64) NOT NULL,
      block_height     INT UNSIGNED,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tx_id, choice_idx),
      KEY idx_votes_poll (poll_id)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE wealth_snapshots (
      bucket_ts              DATETIME PRIMARY KEY,
      total_supply           BIGINT UNSIGNED,
      addresses_with_balance INT UNSIGNED,
      gini                   DECIMAL(10, 8),
      top1pct_share          DECIMAL(10, 8),
      top10pct_share         DECIMAL(10, 8),
      top100_share           DECIMAL(10, 8),
      active_24h             INT UNSIGNED,
      new_24h                INT UNSIGNED,
      hodler_30d             INT UNSIGNED,
      hodler_180d            INT UNSIGNED,
      _ingested_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ${sql.raw(T)}
  `.execute(db);

  // ---- Projects / protocol / sidestakes / mrc / clusters (DuckDB 0003) ----

  await sql`
    CREATE TABLE project_contracts (
      project_name     VARCHAR(255) NOT NULL,
      action           VARCHAR(8),
      base_url         TEXT,
      contract_version TINYINT UNSIGNED,
      tx_id            VARCHAR(64) NOT NULL,
      block_height     INT UNSIGNED NOT NULL,
      time             DATETIME,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_name, block_height, tx_id)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE protocol_entries (
      \`key\`            VARCHAR(255) NOT NULL,
      \`value\`          TEXT,
      status           VARCHAR(32),
      contract_version TINYINT UNSIGNED,
      tx_id            VARCHAR(64) NOT NULL,
      previous_hash    VARCHAR(64),
      block_height     INT UNSIGNED NOT NULL,
      time             DATETIME NOT NULL,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`key\`, time, tx_id)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE project_users (
      cpid             VARCHAR(32) NOT NULL,
      project_name     VARCHAR(255) NOT NULL,
      user_id          BIGINT UNSIGNED,
      name             VARCHAR(255),
      country          VARCHAR(64) DEFAULT '',
      total_credit     DOUBLE DEFAULT 0,
      expavg_credit    DOUBLE DEFAULT 0,
      create_time      INT UNSIGNED DEFAULT 0,
      last_imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (cpid, project_name),
      KEY idx_project_users_name (name)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE project_user_imports (
      project_name      VARCHAR(255) PRIMARY KEY,
      last_attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_success_at   DATETIME,
      user_count        INT UNSIGNED DEFAULT 0,
      last_status       VARCHAR(32) DEFAULT '',
      last_error        TEXT
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE mandatory_sidestakes (
      address          VARCHAR(64) NOT NULL,
      action           VARCHAR(8),
      status           VARCHAR(16),
      allocation_pct   DOUBLE,
      description      TEXT,
      contract_version TINYINT UNSIGNED,
      tx_id            VARCHAR(64) NOT NULL,
      block_height     INT UNSIGNED NOT NULL,
      time             DATETIME,
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (address, block_height, tx_id)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE coinstake_sidestakes (
      address        VARCHAR(64) NOT NULL,
      block_height   INT UNSIGNED NOT NULL,
      vout_idx       SMALLINT UNSIGNED NOT NULL,
      tx_id          VARCHAR(64),
      amount         BIGINT UNSIGNED,
      allocation_pct DOUBLE,
      time           DATETIME,
      _ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (address, block_height, vout_idx)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE mempool_snapshots (
      block_height INT UNSIGNED NOT NULL,
      block_hash   VARCHAR(64),
      block_time   DATETIME,
      captured_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      tx_id        VARCHAR(64) NOT NULL,
      first_seen   DATETIME,
      fee_estimate BIGINT UNSIGNED,
      size         INT UNSIGNED,
      vin_count    SMALLINT UNSIGNED,
      vout_count   SMALLINT UNSIGNED,
      was_included TINYINT(1),
      PRIMARY KEY (block_height, tx_id)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE mrc_requests (
      tx_id            VARCHAR(64) PRIMARY KEY,
      cpid             VARCHAR(32),
      client_version   VARCHAR(64),
      organization     VARCHAR(255),
      research_subsidy BIGINT UNSIGNED,
      fee_offered      BIGINT UNSIGNED,
      magnitude        DOUBLE,
      magnitude_unit   DOUBLE,
      last_block_hash  VARCHAR(64),
      pay_to_address   VARCHAR(64),
      first_seen       DATETIME,
      block_height     INT UNSIGNED,
      block_time       DATETIME,
      version          TINYINT UNSIGNED DEFAULT 1,
      signature        VARCHAR(255) DEFAULT '',
      _ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_mrc_requests_cpid (cpid),
      KEY idx_mrc_requests_block_time (block_time)
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE address_clusters (
      address      VARCHAR(64) PRIMARY KEY,
      cluster_id   VARCHAR(64),
      cluster_size INT UNSIGNED,
      _ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY idx_address_clusters_cluster (cluster_id)
    ) ${sql.raw(T)}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'address_clusters', 'mrc_requests', 'mempool_snapshots', 'coinstake_sidestakes',
    'mandatory_sidestakes', 'project_user_imports', 'project_users', 'protocol_entries',
    'project_contracts', 'wealth_snapshots', 'votes', 'poll_options', 'polls',
    'beacons', 'superblock_projects', 'superblock_magnitudes', 'superblocks',
    'claim_mrcs', 'claims', 'tx_messages', 'mempool_txs', 'network_snapshots',
    'address_balance_history', 'tx_inputs', 'tx_outputs', 'transactions', 'blocks',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await sql`DROP TABLE IF EXISTS ${sql.ref(t)}`.execute(db);
  }
}
