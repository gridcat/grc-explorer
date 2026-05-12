import { config } from '../../config';
import { ch } from '../../lib/ch';
import { events } from '../../lib/emitter';
import { liveRpc } from '../../lib/gridcoin';
import { log } from '../../lib/log';
import { getCursor, setCursor } from '../../lib/redis';
import { releaseSpentUtxos } from './PhantomSpendDetector';

interface CursorPosition {
  height: number;
  hash: string;
}

// Reorg semantics on ClickHouse are much simpler than on MySQL.
//
// Old MySQL flow: walk back, DELETE rows from blocks/transactions/
// tx_outputs/tx_inputs/address_balance_history/etc. for each rolled-back
// height, in a single transaction per height. Slow, lots of code.
//
// New CH flow: just move the Redis cursor back to the fork point. The
// TipFollower's next tick will re-walk forward from cursor+1 and call
// `applyBlock`, which assigns a fresh `_seq` (Redis INCR). Every CH
// table is `ReplacingMergeTree(_seq)`, so the new versions of rows at
// those heights supersede the old ones at merge time; queries that
// need eager correctness use FINAL or argMax(_seq, …). No DELETEs,
// no per-table walks, no transaction-management.
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

    // Release abandoned UTXO claims from the spent-UTXO set before
    // the forward replay re-walks the new chain. Without this, every
    // re-spend in the new chain would look like a phantom and lose
    // its address_balance_history debit. The forward replay's SADD
    // re-populates the set with whichever UTXOs the new chain spends.
    await this.releaseAbandonedUtxos(fork.height + 1, cursor.height);

    // Move cursor; TipFollower's next tick re-applies fork+1 onward with
    // a fresh _seq, naturally superseding the abandoned chain.
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
    const result = await ch.query({
      query: `
        SELECT height, hash
        FROM blocks FINAL
        WHERE height >= {start: UInt32}
        ORDER BY height DESC
        LIMIT 20
      `,
      query_params: { start: startHeight },
      format: 'JSONEachRow',
    });
    const stored = await result.json<{ height: number; hash: string }>();

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

  private async releaseAbandonedUtxos(from: number, to: number): Promise<void> {
    if (to < from) return;
    // We only need to release UTXOs that the abandoned chain marked
    // as first-spent. Phantom re-claims in the abandoned range don't
    // own their SET entry — its canonical spender lives in some
    // earlier (still-live) block — so SREM is restricted to
    // non-phantom rows. `is_phantom_spend` defaults to false on
    // pre-migration rows, which is the correct interpretation for
    // pre-existing data.
    const result = await ch.query({
      query: `
        SELECT prev_tx, prev_vout
        FROM tx_inputs FINAL
        WHERE block_height >= {from: UInt32}
          AND block_height <= {to: UInt32}
          AND prev_tx IS NOT NULL
          AND is_phantom_spend = false
      `,
      query_params: { from, to },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ prev_tx: string; prev_vout: number }>();
    await releaseSpentUtxos(rows.map((r) => `${r.prev_tx}:${r.prev_vout}`));
  }

  private async collectAbandonedHashes(from: number, to: number): Promise<string[]> {
    if (to < from) return [];
    const result = await ch.query({
      query: `
        SELECT hash FROM blocks FINAL
        WHERE height >= {from: UInt32} AND height <= {to: UInt32}
        ORDER BY height
      `,
      query_params: { from, to },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ hash: string }>();
    return rows.map((r) => r.hash);
  }

  private async getStoredHash(height: number): Promise<string | null> {
    const result = await ch.query({
      query: 'SELECT hash FROM blocks FINAL WHERE height = {h: UInt32}',
      query_params: { h: height },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ hash: string }>();
    return rows[0]?.hash ?? null;
  }

  private async getBlockHash(height: number): Promise<string> {
    return (liveRpc as unknown as { getBlockHash: (h: number) => Promise<string> }).getBlockHash(height);
  }
}
