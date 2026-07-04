import { config } from '../../config';
import { repairAddressState } from '../../lib/addressState';
import { deleteChainRowsAtOrAboveHeight } from '../../lib/chainTables';
import { purgeReorgCache } from '../../lib/cfPurge';
import { query } from '../../lib/db';
import { events } from '../../lib/emitter';
import { liveRpc } from '../../lib/gridcoin';
import { log } from '../../lib/log';
import { getCursor, setCursor } from '../../lib/redis';

interface CursorPosition {
  height: number;
  hash: string;
}

// Reorg semantics: delete every chain row above the fork point, then
// move the Redis cursor back to it. The TipFollower's next tick re-walks
// forward from cursor+1 and re-applies the new chain into the now-empty
// gap. The DELETE walk is required because chain tables are written ON
// CONFLICT DO NOTHING (see BlockWriter): without first clearing the
// abandoned rows, a re-applied height would be skipped as a no-op and
// keep its stale (abandoned-chain) values. Clearing the range also
// removes the orphan rows the old upsert-overwrite-in-place design left
// behind.
//
// Two entry points are preserved on the public surface:
//   - `handle()` — called by TipFollower on a `previousblockhash`
//     mismatch. Walks back until the chain agrees with the daemon,
//     moves the cursor, returns the fork.
//   - `safetySweep()` — periodic check that the last 20 stored hashes
//     still match the daemon. Catches silent reorgs the hot path missed.

export class ChainReorgHandler {
  async handle(): Promise<CursorPosition> {
    const cursor = await getCursor();
    if (!cursor) throw new Error('ChainReorgHandler: cursor missing');

    const fork = await this.findForkPoint(cursor.height);
    if (!fork) {
      log.error('ChainReorgHandler: walk-back exceeded MAX_REORG_DEPTH; aborting');
      await setCursor({ height: cursor.height, hash: cursor.hash, status: 'reorg' });
      throw new Error(`Reorg deeper than MAX_REORG_DEPTH (${config.MAX_REORG_DEPTH})`);
    }

    const depth = cursor.height - fork.height;
    const abandoned = await this.collectAbandonedHashes(fork.height + 1, cursor.height);
    log.warn(`Reorg detected — moving cursor back ${depth} blocks to fork ${fork.height}/${fork.hash}`);

    // (Spent-UTXO release is implicit now: phantom detection reads
    // tx_inputs directly, and deleteChainRowsAtOrAboveHeight below
    // removes the abandoned spends, so the new chain's re-spends are
    // first-spends again without a separate release step.)

    // Capture which addresses the abandoned range touched BEFORE the
    // rows vanish — the exact set whose address_state running totals
    // absorbed abandoned deltas. Served by idx_abh_height; bounded by
    // MAX_REORG_DEPTH blocks' worth of activity.
    const dirtyAddresses = await this.collectAffectedAddresses(fork.height + 1);

    // Delete the abandoned chain rows (fork+1 .. cursor) so the forward
    // replay re-inserts into a clean gap. Must happen before the cursor
    // moves: chain writes are DO NOTHING, so a height that still has its
    // abandoned row would be skipped instead of replaced.
    await deleteChainRowsAtOrAboveHeight(fork.height + 1);

    // Exact projection repair: recompute the touched addresses from the
    // surviving event log (delete-then-reinsert inside). The forward
    // replay then re-applies the new chain's deltas additively on top.
    await repairAddressState(dirtyAddresses);

    // Evict the edge cache for the rolled-back range so Cloudflare doesn't
    // keep serving the abandoned chain. Best-effort + no-op when CF isn't
    // configured; never blocks the reorg (the rollup tables self-correct
    // on the forward replay's next refreshRollups pass).
    await purgeReorgCache(fork.height + 1);

    // Move cursor; TipFollower's next tick re-applies fork+1 onward into
    // the cleared range.
    await setCursor({ height: fork.height, hash: fork.hash, status: 'live' });

    events.publish({
      topic: 'chain.reorg',
      payload: {
        fork_height: fork.height,
        depth,
        abandoned_hashes: abandoned,
        new_hashes: [],
      },
    });
    return fork;
  }

  async safetySweep(): Promise<void> {
    const cursor = await getCursor();
    if (!cursor || cursor.status !== 'live') return;

    const startHeight = Math.max(0, cursor.height - 20);
    const stored = await query<{ height: number; hash: string }>(
      `
        SELECT height, hash
        FROM blocks
        WHERE height >= $start
        ORDER BY height DESC
        LIMIT 20
      `,
      { start: startHeight },
    );

    for (const row of stored) {
      // eslint-disable-next-line no-await-in-loop
      const onchain = await this.getBlockHash(row.height);
      if (onchain !== row.hash) {
        log.warn(`Safety sweep found drift at height ${row.height}; triggering reorg handler`);
        await this.handle();
        return;
      }
    }
  }

  private async findForkPoint(fromHeight: number): Promise<CursorPosition | null> {
    for (let walk = 0; walk <= config.MAX_REORG_DEPTH; walk += 1) {
      const probeHeight = fromHeight - walk;
      if (probeHeight < 0) return null;
      // eslint-disable-next-line no-await-in-loop
      const onchain = await this.getBlockHash(probeHeight);
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.getStoredHash(probeHeight);
      if (stored && stored === onchain) {
        return { height: probeHeight, hash: onchain };
      }
    }
    return null;
  }

  private async collectAffectedAddresses(from: number): Promise<string[]> {
    const rows = await query<{ address: string }>(
      `
        SELECT DISTINCT address
        FROM address_balance_history
        WHERE valid_from_height >= $from AND address != ''
      `,
      { from },
    );
    return rows.map((r) => r.address);
  }

  private async collectAbandonedHashes(from: number, to: number): Promise<string[]> {
    if (to < from) return [];
    const rows = await query<{ hash: string }>(
      `
        SELECT hash FROM blocks
        WHERE height >= $from AND height <= $to
        ORDER BY height
      `,
      { from, to },
    );
    return rows.map((r) => r.hash);
  }

  private async getStoredHash(height: number): Promise<string | null> {
    const rows = await query<{ hash: string }>(
      'SELECT hash FROM blocks WHERE height = $h',
      { h: height },
    );
    return rows[0]?.hash ?? null;
  }

  private async getBlockHash(height: number): Promise<string> {
    return liveRpc.getBlockHash(height);
  }
}
