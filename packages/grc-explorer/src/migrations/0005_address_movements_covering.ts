import { Kysely, sql } from 'kysely';

// The address detail page is SSR and its getServerSideProps awaits
// /addresses/:a/transactions in parallel with the wallet fetch, so the whole
// page blocks on that endpoint. Its movements query unions every tx_output
// and tx_input for the address, groups by tx_id and sorts by height:
//   SELECT tx_id, block_height, value FROM tx_outputs WHERE address = ?
//   UNION ALL
//   SELECT tx_id, block_height, value FROM tx_inputs  WHERE address = ?
// The existing address indexes — idx_tx_outputs_address (address, block_height)
// and idx_tx_inputs_address (address) — locate the rows but don't carry
// `value` (nor block_height, for tx_inputs), so each of the (tens of)
// thousands of matching rows needs a separate row read to fetch it. Cold
// (buffer pool empty) that scatter-read hit disk: ~10s for a prolific staker
// (~50k movements), which is the "first click on a wallet renders too slow".
//
// Widening both address indexes to (address, block_height, value) makes the
// movements scan index-only (InnoDB secondary indexes implicitly carry the
// PK, so tx_id comes along for free) — a compact sequential range scan
// instead of ~50k random reads. The old narrow indexes are dropped: the new
// ones are supersets on the same leading column, so every address-filtered
// query (pending balance, rich-list cross-links, the movements CTE) keeps a
// usable index.
//
// IF NOT EXISTS / IF EXISTS keep this a safe no-op if the covering indexes
// were ever created out of band.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tx_outputs_addr_val
      ON tx_outputs (address, block_height, value)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tx_inputs_addr_val
      ON tx_inputs (address, block_height, value)
  `.execute(db);
  await sql`ALTER TABLE tx_outputs DROP INDEX IF EXISTS idx_tx_outputs_address`.execute(db);
  await sql`ALTER TABLE tx_inputs DROP INDEX IF EXISTS idx_tx_inputs_address`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs (address, block_height)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_tx_inputs_address ON tx_inputs (address)
  `.execute(db);
  await sql`ALTER TABLE tx_outputs DROP INDEX IF EXISTS idx_tx_outputs_addr_val`.execute(db);
  await sql`ALTER TABLE tx_inputs DROP INDEX IF EXISTS idx_tx_inputs_addr_val`.execute(db);
}
