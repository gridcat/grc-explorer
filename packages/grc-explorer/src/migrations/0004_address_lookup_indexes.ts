import { Kysely, sql } from 'kysely';

// The address detail page runs fetchLinkedWallets() on every load, which
// cross-references the address against its on-chain CPID linkages:
//   SELECT ... FROM blocks        WHERE miner_address  = $addr
//   SELECT ... FROM mrc_requests  WHERE pay_to_address = $addr
// Neither column was indexed — blocks only had (height PK, hash, time,
// staker_cpid) and mrc_requests only (tx_id PK, cpid, block_time) — so
// each of those became a full table scan (blocks is millions of rows and
// grows with the chain). Cold (buffer pool empty) that scan hit disk and
// made the first view of any address slow; a warm re-read was fast, which
// is exactly the "first load slow, then fine" symptom.
//
// Single-column indexes on the two filtered columns turn both into point
// lookups. (beacons.address, tx_outputs.address, tx_inputs.address — the
// address page's other filters — were already indexed.)

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_blocks_miner_address ON blocks (miner_address)
  `.execute(db);
  await sql`
    CREATE INDEX idx_mrc_requests_pay_to ON mrc_requests (pay_to_address)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_blocks_miner_address ON blocks`.execute(db);
  await sql`DROP INDEX idx_mrc_requests_pay_to ON mrc_requests`.execute(db);
}
