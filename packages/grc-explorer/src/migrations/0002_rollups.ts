import { Kysely, sql } from 'kysely';

// Materialised rollup tables — replace the DuckDB recompute-on-read VIEWs
// (duckdb/migrations/0004 + 0007). Same names + columns as those views, so
// the read path barely changes; the difference is they're maintained
// incrementally by RollupMaintainer (recompute the trailing time-window of
// buckets after each applied batch) instead of scanning the base tables on
// every request. On a row store + spinning disk that's the whole point:
// reads hit a tiny hot table, never a full scan of blocks/transactions.
//
// bucket_ts is INT UNSIGNED unix-seconds (truncated to the granularity) so
// it deserialises as a JSON number, matching the old views. Daily rollups
// key on a DATE. Sums of halford are BIGINT UNSIGNED.

const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 5m / 1h / 1d network rollups over blocks.
  for (const g of ['network_5m', 'network_1h', 'network_1d']) {
    // eslint-disable-next-line no-await-in-loop
    await sql`
      CREATE TABLE ${sql.ref(g)} (
        bucket_ts   INT UNSIGNED PRIMARY KEY,
        block_count INT UNSIGNED,
        tx_count    BIGINT UNSIGNED,
        mint_total  BIGINT UNSIGNED,
        bytes_total BIGINT UNSIGNED
      ) ${sql.raw(T)}
    `.execute(db);
  }

  // Money-flow rollups over user txs.
  for (const g of ['tx_5m', 'tx_1h']) {
    // eslint-disable-next-line no-await-in-loop
    await sql`
      CREATE TABLE ${sql.ref(g)} (
        bucket_ts   INT UNSIGNED PRIMARY KEY,
        value_moved BIGINT UNSIGNED,
        fee_total   BIGINT UNSIGNED
      ) ${sql.raw(T)}
    `.execute(db);
  }

  // Staking-subsidy rollups over claims.
  for (const g of ['claims_5m', 'claims_1h']) {
    // eslint-disable-next-line no-await-in-loop
    await sql`
      CREATE TABLE ${sql.ref(g)} (
        bucket_ts              INT UNSIGNED PRIMARY KEY,
        research_subsidy_total BIGINT UNSIGNED,
        block_subsidy_total    BIGINT UNSIGNED
      ) ${sql.raw(T)}
    `.execute(db);
  }

  await sql`
    CREATE TABLE fee_quantiles_1h (
      bucket_ts INT UNSIGNED PRIMARY KEY,
      p50       DOUBLE,
      p95       DOUBLE,
      p99       DOUBLE,
      tx_count  BIGINT UNSIGNED
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE archive_blocks_daily (
      bucket_date      DATE PRIMARY KEY,
      block_count      INT UNSIGNED,
      tx_count         BIGINT UNSIGNED,
      mint_total       BIGINT UNSIGNED,
      bytes_total      BIGINT UNSIGNED,
      pos_count        INT UNSIGNED,
      superblock_count INT UNSIGNED
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE archive_txs_daily (
      bucket_date   DATE PRIMARY KEY,
      value_moved   BIGINT UNSIGNED,
      fee_total     BIGINT UNSIGNED,
      user_tx_count BIGINT UNSIGNED
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE archive_minters_daily (
      bucket_date  DATE PRIMARY KEY,
      miners_uniq  INT UNSIGNED,
      stakers_uniq INT UNSIGNED
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE difficulty_daily (
      bucket_date      DATE PRIMARY KEY,
      difficulty_min   DOUBLE,
      difficulty_max   DOUBLE,
      difficulty_avg   DOUBLE,
      difficulty_count INT UNSIGNED,
      difficulty_open  DOUBLE,
      difficulty_close DOUBLE
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE stakers_daily (
      bucket_date        DATE PRIMARY KEY,
      researcher_stakers INT UNSIGNED,
      investor_stakers   INT UNSIGNED,
      total_stakers      INT UNSIGNED,
      mint_sum           BIGINT UNSIGNED,
      pos_blocks         INT UNSIGNED
    ) ${sql.raw(T)}
  `.execute(db);

  await sql`
    CREATE TABLE client_versions_daily (
      bucket_date DATE NOT NULL,
      raw_version VARCHAR(64) NOT NULL,
      blocks      BIGINT UNSIGNED,
      PRIMARY KEY (bucket_date, raw_version)
    ) ${sql.raw(T)}
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'network_5m', 'network_1h', 'network_1d', 'tx_5m', 'tx_1h',
    'claims_5m', 'claims_1h', 'fee_quantiles_1h', 'archive_blocks_daily',
    'archive_txs_daily', 'archive_minters_daily', 'difficulty_daily',
    'stakers_daily', 'client_versions_daily',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await sql`DROP TABLE IF EXISTS ${sql.ref(t)}`.execute(db);
  }
}
