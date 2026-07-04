import { Kysely, sql } from 'kysely';

// Per-(address, tx) movements projection. The address page's
// transactions list used to UNION every tx_outputs/tx_inputs row the
// address ever produced, GROUP BY tx_id and filesort — O(entire
// address history) on EVERY page view (~0.6 s warm / seconds cold for
// a 50k-movement staker; the one remaining O(history) read path after
// the low-resource rework). This table stores the net per-tx delta at
// write time, so a page is a 25-entry clustered-PK range read.
//
// delta = Σ outputs.value − Σ non-phantom inputs.value for that
// address in that tx. Phantom re-claims (Halford-era kernel reuse) are
// EXCLUDED — the old inline query subtracted them, silently showing
// spends that never debited the balance; the projection matches
// address_state/address_balance_history semantics instead.
//
// Backfilled here in two passes (outputs add, inputs subtract via the
// additive upsert) — a one-time sort-heavy aggregation on the box that
// runs the migration; prod receives the table inside the physical
// seed. Maintained per batch by BlockWriter (insertAddressTxs, INSERT
// IGNORE — a (address, tx) aggregate is immutable once its block is
// written) and rolled back by height like every chain table
// (lib/chainTables.ts).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS address_txs (
      address      VARCHAR(64) NOT NULL,
      block_height INT UNSIGNED NOT NULL,
      tx_id        VARCHAR(64) NOT NULL,
      delta        BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (address, block_height, tx_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC
  `.execute(db);

  await sql`
    INSERT INTO address_txs (address, block_height, tx_id, delta)
    SELECT address, block_height, tx_id, CAST(SUM(value) AS SIGNED)
    FROM tx_outputs
    WHERE address != ''
    GROUP BY address, block_height, tx_id
    ON DUPLICATE KEY UPDATE delta = delta + VALUES(delta)
  `.execute(db);

  await sql`
    INSERT INTO address_txs (address, block_height, tx_id, delta)
    SELECT address, block_height, tx_id, -CAST(SUM(value) AS SIGNED)
    FROM tx_inputs
    WHERE address IS NOT NULL AND address != ''
      AND value IS NOT NULL AND is_phantom_spend = false
    GROUP BY address, block_height, tx_id
    ON DUPLICATE KEY UPDATE delta = delta + VALUES(delta)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS address_txs`.execute(db);
}
