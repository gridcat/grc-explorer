import { Kysely, sql } from 'kysely';

// Wallet current-state projection moves Redis → MariaDB.
//
// The Redis projection (`wallet:{addr}` HSET + wallets:by_balance /
// by_last_seen ZSETs) grew to ~3.4M keys / ~2.9 GB — bigger than the
// entire RAM envelope of the prod box. As an InnoDB table the same
// state is ~270 MB on disk with a hot set of a few tens of MB in the
// buffer pool, and it travels inside the mariabackup seed to prod
// (no rebuild step on deploy). Every consumer maps to an indexed
// query:
//   rich list      → ORDER BY balance DESC LIMIT (idx_address_state_balance)
//   address page   → PK point lookup
//   prefix search  → address LIKE 'x%' (PK range scan)
//   wealth current → WHERE balance > 0 ORDER BY balance DESC (index-only)
//
// Column types mirror the Redis hash fields; address matches
// address_balance_history.address (VARCHAR(64), table-default charset)
// so joins/IN-lists never cross collations.
//
// idx_abh_height backs three consumers on address_balance_history:
//   - WealthSnapshotJob's streaming/differential passes (deltas by
//     height window),
//   - reorg repair (DISTINCT address above the fork),
//   - any "recent activity" height-range scan.
// The PK is (address, valid_from_height), so a bare height predicate
// was a full scan before this.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS address_state (
      address          VARCHAR(64) NOT NULL,
      balance          BIGINT NOT NULL DEFAULT 0,
      total_received   BIGINT UNSIGNED NOT NULL DEFAULT 0,
      total_sent       BIGINT UNSIGNED NOT NULL DEFAULT 0,
      tx_count         INT UNSIGNED NOT NULL DEFAULT 0,
      first_seen_block INT UNSIGNED NULL,
      last_seen_block  INT UNSIGNED NULL,
      PRIMARY KEY (address),
      -- Composite ON PURPOSE: the rich list orders by
      -- (balance DESC, address DESC) and the optimizer does NOT
      -- reliably use a secondary index's implicit PK suffix for ORDER
      -- BY elimination — a bare (balance) index left it filesorting
      -- 3.4M rows per page. The explicit suffix makes the backward
      -- scan a guaranteed match.
      KEY idx_address_state_balance (balance, address)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_abh_height
      ON address_balance_history (valid_from_height)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS address_state`.execute(db);
  await sql`
    ALTER TABLE address_balance_history DROP INDEX IF EXISTS idx_abh_height
  `.execute(db);
}
