import { Kysely, sql } from 'kysely';

// Addresses proven co-owned by poll votes: one row per (vote tx,
// address) whose balance claim signature verified (lib/voteClaim.ts,
// filled by services/jobs/VoteClaimJob.ts). Feeds the vote arm of the
// address page's linked wallets. Not displayed per vote.
//
// PK (tx_id, address) makes re-processing a height range idempotent;
// idx (address) serves "votes this address was claimed in" and carries
// tx_id via the PK suffix; idx (block_height) serves reorg rollback.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS vote_claim_addresses (
      tx_id        VARCHAR(64) NOT NULL,
      address      VARCHAR(64) NOT NULL,
      block_height INT UNSIGNED NOT NULL,
      PRIMARY KEY (tx_id, address),
      KEY idx_vote_claim_addresses_address (address),
      KEY idx_vote_claim_addresses_block (block_height)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS vote_claim_addresses`.execute(db);
}
