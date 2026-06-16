import { query } from '../lib/db';
import { log } from '../lib/log';
import { applyWalletDelta, clearWalletProjections } from '../lib/redis';

// Walks `address_balance_history` ordered by (address, valid_from_height)
// and re-applies every per-block delta into the Redis wallet projection.
// Used on cold start when Redis is empty (or has been wiped) to rebuild
// the canonical current-state from the immutable CH event log.
//
// Streams in pages so we don't load N million rows into memory at once.
// Per-row work is one HINCRBY pipeline — fast enough that mainnet's
// full address-history walk completes in minutes.

const PAGE_SIZE = 50_000;

export async function rebuildWallets(): Promise<number> {
  const cleared = await clearWalletProjections();
  log.info(`rebuildWallets: cleared ${cleared} existing wallet keys`);

  let offset = 0;
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    type Row = {
      address: string; valid_from_height: number;
      delta: string; received: string; sent: string; tx_count_delta: number;
    };
    // eslint-disable-next-line no-await-in-loop
    const rows = await query<Row>(
      `
        SELECT
          address,
          valid_from_height,
          delta,
          received,
          sent,
          tx_count_delta
        FROM address_balance_history
        WHERE address != ''
        ORDER BY address, valid_from_height
        LIMIT ${PAGE_SIZE} OFFSET $offset
      `,
      { offset },
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await applyWalletDelta(
        r.address,
        BigInt(r.delta),
        BigInt(r.received),
        BigInt(r.sent),
        r.tx_count_delta,
        r.valid_from_height,
      );
    }
    total += rows.length;
    offset += PAGE_SIZE;
    log.info(`rebuildWallets: applied ${total} delta rows (offset ${offset})`);
    if (rows.length < PAGE_SIZE) break;
  }

  log.info(`rebuildWallets: complete; ${total} delta rows replayed into Redis`);
  return total;
}

// CLI entrypoint — only fires when this file is run directly (e.g.
// `ts-node src/scripts/rebuildWallets.ts`). Importing the module from
// the partial-wipe path doesn't execute this branch.
if (require.main === module) {
  log.info('rebuildWallets: starting');
  rebuildWallets()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('rebuildWallets failed', err);
      process.exit(1);
    });
}
