import { query, run } from '../lib/db';
import { log } from '../lib/log';

// Rebuilds the `address_state` projection from the immutable
// address_balance_history event log in one INSERT…SELECT. Replaces the
// old rebuildWallets Redis replay (per-row HINCRBY pipeline, minutes) —
// the GROUP BY streams in (address, valid_from_height) PK order, so
// there's no sort and no app-side row traffic.
//
// Disaster-recovery / cold-start tool: the projection normally travels
// inside the mariabackup seed and is maintained per batch by the
// indexer (applyAddressStateDeltas) + repaired exactly after reorgs
// (repairAddressState), so routine deploys never need this.

export async function rebuildAddressState(): Promise<number> {
  log.info('rebuildAddressState: truncating projection');
  await run('TRUNCATE TABLE address_state');

  await run(
    `
      INSERT INTO address_state
        (address, balance, total_received, total_sent, tx_count,
         first_seen_block, last_seen_block)
      SELECT
        address,
        COALESCE(SUM(delta), 0),
        COALESCE(SUM(received), 0),
        COALESCE(SUM(sent), 0),
        COALESCE(SUM(tx_count_delta), 0),
        MIN(valid_from_height),
        MAX(valid_from_height)
      FROM address_balance_history
      WHERE address != ''
      GROUP BY address
    `,
  );

  const rows = await query<{ c: number | string }>('SELECT count(*) AS c FROM address_state');
  const total = Number(rows[0]?.c ?? 0);
  log.info(`rebuildAddressState: complete; ${total} addresses projected`);
  return total;
}

// CLI entrypoint — only fires when this file is run directly (e.g.
// `ts-node src/scripts/rebuildAddressState.ts`).
if (require.main === module) {
  log.info('rebuildAddressState: starting');
  rebuildAddressState()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('rebuildAddressState failed', err);
      process.exit(1);
    });
}
