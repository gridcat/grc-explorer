import { rpc } from '../../lib/gridcoin';
import { events } from '../../lib/emitter';
import { log } from '../../lib/log';
import { getCursor, setCursor } from '../../lib/redis';
import { applyBlock } from './BlockWriter';
import { ChainReorgHandler } from './ChainReorgHandler';
import { parseBlock } from './ContractParser';
import { buildPrevOutputsLookup } from './prevOutputs';
import { VerboseBlock } from './types';

/**
 * Stays on the chain tip. On every tick:
 *   1. Read the daemon's tip height.
 *   2. If our `last_indexed_height < tip`, fetch the next block.
 *   3. Verify hashPrevBlock matches our stored tip; on mismatch,
 *      delegate to ChainReorgHandler before applying.
 *   4. Apply the block; loop until caught up.
 *
 * Skips ticks while the indexer is still in `backfilling` state — the
 * HistoricalBackfiller owns chain progress until handoff.
 */

/**
 * Hand back to HistoricalBackfiller when our cursor is more than this
 * many blocks behind the daemon's tip. TipFollower applies one block
 * per Prisma transaction; HistoricalBackfiller batches `BACKFILL_TX_BATCH_SIZE`
 * per transaction. With a 3M-block lag the difference is hours vs days.
 *
 * Real-world cause this protects against: HistoricalBackfiller marked
 * us live when the daemon's `getblockchaininfo().blocks` was small
 * (daemon still syncing at boot), then the daemon caught up to a much
 * larger height. Without this, TipFollower would walk the full lag one
 * block at a time, which is impractical for testnet/mainnet history.
 */
// Roughly a week of Gridcoin chain time (90 s block target × 7 days
// ≈ 6720). A normal redeploy or short outage falls behind by tens-to-
// hundreds of blocks; we don't want to flip into "backfilling" and
// trigger the post-backfill Meili reindex for that. Only catastrophic
// gaps (a week+ off-line, a fresh deploy with stale state) should
// enter bulk backfill mode.
const LAG_THRESHOLD_FOR_REBACKFILL = 7000;

export class TipFollower {
  constructor(private readonly reorg: ChainReorgHandler) {}

  async tick(): Promise<void> {
    const state = await getCursor();
    if (state && state.status !== 'live') return;

    const tipHeight = await this.getTipHeight();
    // Cursor sentinel: -1 means "fresh DB, walk genesis next." We can't
    // store -1 in a UInt32 height column, so getCursor returns null and
    // we treat that as -1 here. nextHeight then starts at 0 (genesis),
    // which is critical: skipping genesis means block 1's vins point at
    // UTXOs we never indexed, leaving address-balance deltas unanchored
    // (the spending address has prev_balance=0 in our CH, but a real
    // value on chain → running_balance underflows on the next sent tx).
    const cursorHeight = state ? state.height : -1;
    const cursorHash = state ? state.hash : '';

    if (tipHeight <= cursorHeight) {
      events.publish({
        topic: 'block.tip',
        payload: { tip_height: tipHeight, tip_hash: cursorHash },
      });
      return;
    }

    // If we're far behind the chain, the per-block path of this loop
    // is the wrong tool. Flip status back to `backfilling` and let
    // HistoricalBackfiller batch us forward; the next backfiller tick
    // (which fires on its own internal loop, plus on every restart)
    // will resume from this cursor.
    if (tipHeight - cursorHeight > LAG_THRESHOLD_FOR_REBACKFILL) {
      log.warn(
        `TipFollower lag ${tipHeight - cursorHeight} blocks > ${LAG_THRESHOLD_FOR_REBACKFILL}; re-entering backfilling mode`,
      );
      if (state) {
        await setCursor({ height: state.height, hash: state.hash, status: 'backfilling' });
      }
      // No state means fresh DB: HistoricalBackfiller's `state ? state.height + 1 : 0`
      // walks from genesis, which is exactly what we want. Don't write
      // a sentinel cursor here — that would clamp the start height to
      // 0+1=1 and skip genesis, breaking the running-balance invariant.
      return;
    }

    let cursor = cursorHeight;
    let cursorHashLocal = cursorHash;

    while (cursor < tipHeight) {
      const nextHeight = cursor + 1;
      // eslint-disable-next-line no-await-in-loop
      const nextHash = await this.getBlockHash(nextHeight);
      // eslint-disable-next-line no-await-in-loop
      const block = await this.getBlock(nextHash);

      if (cursorHashLocal && block.previousblockhash !== cursorHashLocal) {
        log.warn(
          `Reorg detected at height ${nextHeight}: incoming prev=${block.previousblockhash} != db.tip=${cursorHashLocal}`,
        );
        // eslint-disable-next-line no-await-in-loop
        const newCursor = await this.reorg.handle();
        cursor = newCursor.height;
        cursorHashLocal = newCursor.hash;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const lookup = await buildPrevOutputsLookup(block.tx);
      const parsed = parseBlock(block, lookup);
      // eslint-disable-next-line no-await-in-loop
      await applyBlock(parsed);

      cursor = nextHeight;
      cursorHashLocal = block.hash;
    }

    events.publish({
      topic: 'block.tip',
      payload: { tip_height: cursor, tip_hash: cursorHashLocal },
    });
  }

  private async getTipHeight(): Promise<number> {
    const info = await (rpc as unknown as { getBlockchainInfo: () => Promise<{ blocks: number }> })
      .getBlockchainInfo();
    return info.blocks;
  }

  private async getBlockHash(height: number): Promise<string> {
    return (rpc as unknown as { getBlockHash: (h: number) => Promise<string> }).getBlockHash(height);
  }

  private async getBlock(hash: string): Promise<VerboseBlock> {
    return (rpc as unknown as {
      getBlock: <T extends boolean>(h: string, txinfo: T) => Promise<unknown>;
    }).getBlock(hash, true) as Promise<VerboseBlock>;
  }
}
