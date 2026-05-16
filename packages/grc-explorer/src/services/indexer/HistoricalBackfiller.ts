import { config } from '../../config';
import { heavyRpc, liveRpc, simpleRpc } from '../../lib/gridcoin';
import { log } from '../../lib/log';
import { events } from '../../lib/emitter';
import { getCursor, isWipeInProgress, setCursor } from '../../lib/redis';
import { adaptiveLimits } from './AdaptiveLimits';
// MeiliReindexJob skipped this chunk — search path ports in Phase 3.
import { applyBlocks } from './BlockWriter';
import { parseBlock, ParsedBlock } from './ContractParser';
import { buildPrevOutputsLookupMulti } from './prevOutputs';
import { VerboseBlock } from './types';

/**
 * Walk the chain from genesis (or the last persisted height) up to
 * (tip - SAFE_DEPTH), then hand off to TipFollower. Resumable across
 * restarts via the `indexer_state` row.
 *
 * Concurrency: we pull `BACKFILL_CONCURRENCY` blocks in flight at a
 * time but apply them in strict height order, so a slow `getblock`
 * for height N doesn't let height N+1 land first and corrupt the
 * forward-only `prev_tx` invariant the parser relies on.
 */
export class HistoricalBackfiller {
  private aborted = false;

  abort(): void {
    this.aborted = true;
  }

  /** Returns true if a handoff to TipFollower is now possible. */
  async run(): Promise<boolean> {
    const state = await getCursor();
    const nextHeight = state ? state.height + 1 : 0;
    const status = state?.status ?? 'backfilling';
    if (status !== 'backfilling') {
      // Already past backfill.
      return true;
    }

    const tipHeight = await this.getTipHeight();
    const targetHeight = Math.max(0, tipHeight - config.SAFE_CONFIRMATIONS);

    if (nextHeight > targetHeight) {
      await this.markLive();
      return true;
    }

    const modeTag = config.BACKFILL_SEQUENTIAL ? ' [sequential]' : '';
    log.info(`Backfilling from height ${nextHeight} → ${targetHeight} (tip=${tipHeight})${modeTag}`);

    if (config.BACKFILL_SEQUENTIAL) {
      // Sequential mode: one block at a time, fetched + parsed +
      // committed before the next call. Slow but boring; bypasses
      // semaphore, AIMD, fetch buffer and txBatchSize accumulator.
      // Each committed block is durable before the next fetch
      // starts, so a single RPC failure costs at most one block of
      // work — the schedule's next tick resumes from the cursor.
      await this.processRangeSequential(nextHeight, targetHeight, tipHeight);
    } else {
      // One continuous pump: fetcher stays full from `nextHeight` all the
      // way to `targetHeight`. The earlier windowed loop drained the
      // fetcher pipeline at every BACKFILL_BATCH_SIZE boundary (and slept
      // 100ms between windows), which left the daemon idle while we
      // spun up the next 8 parallel RPCs. With no API customers during
      // the catch-up window the yield is unnecessary, and `processRange`
      // already flushes per BACKFILL_TX_BATCH_SIZE so commit cadence is
      // unchanged — the only thing that disappears is the gap.
      await this.processRange(nextHeight, targetHeight, tipHeight);
    }

    if (!this.aborted) {
      await this.markLive();
      log.info('Backfill complete; handing off to TipFollower');
      return true;
    }
    return false;
  }

  private async getTipHeight(): Promise<number> {
    const info = await liveRpc.getBlockchainInfo();
    return info.blocks;
  }

  private async markLive(): Promise<void> {
    const cursor = await getCursor();
    await setCursor({
      height: cursor?.height ?? 0,
      hash: cursor?.hash ?? '',
      status: 'live',
    });
    // MeiliReindexJob fires after backfill in the old MySQL world. It's
    // a Phase-3 chunk; the chain-data spine doesn't depend on it. The
    // dirty-sentinel auto-reindex will re-attach once the search path
    // is ported.
  }

  /**
   * Boring sequential walk: one block per RPC, committed before the
   * next fetch starts. No semaphore, no AIMD, no buffer Map, no
   * pending accumulator, no out-of-order arrivals. If any step
   * throws, the loop returns and the schedule's next 60s tick
   * resumes from the persisted cursor. Throughput floor; durability
   * ceiling. Toggled by BACKFILL_SEQUENTIAL=true.
   */
  private async processRangeSequential(
    from: number,
    to: number,
    tipHeight: number,
  ): Promise<void> {
    /* eslint-disable no-await-in-loop */
    for (let height = from; height <= to; height += 1) {
      if (this.aborted) return;
      if (await isWipeInProgress()) {
        log.info('HistoricalBackfiller: wipe in progress, aborting sequential walk');
        return;
      }

      const result = await simpleRpc.getBlocksBatch(height, 1, true);
      const block = (result?.blocks?.[0] as unknown as VerboseBlock | undefined);
      if (!block || typeof block.height !== 'number') {
        // Daemon answered but didn't return the block we asked for.
        // Bail this run; the next schedule tick retries from the
        // same height (cursor isn't advanced, so we'll retry).
        log.warn(
          `HistoricalBackfiller (sequential): no block at height ${height}; will retry next tick`,
        );
        return;
      }

      const lookup = await buildPrevOutputsLookupMulti([block.tx]);
      const parsed = parseBlock(block, lookup);
      await applyBlocks([parsed], { emitLiveEvents: true, deferPostCommit: true });

      const pct = tipHeight > 0 ? (height / tipHeight) * 100 : 0;
      events.publish({
        topic: 'backfill.progress',
        payload: { height, tip: tipHeight, pct },
      });
      if (height % 1_000 === 0) {
        log.info(
          `Backfill progress (sequential): ${height}/${tipHeight} (${pct.toFixed(2)}%)`,
        );
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  /** Pull and apply blocks `[from, to]` inclusive in strict height order. */
  private async processRange(from: number, to: number, tipHeight: number): Promise<void> {
    // Pipeline: fetcher pumps up to `concurrency` *spans* of consecutive
    // blocks at once via `getblocksbatch`, but the writer drains them
    // sequentially keyed on `expectedHeight`, ensuring strictly forward
    // order. Each span fetch is one RPC round-trip returning N blocks;
    // before this we issued `getblockhash` + `getblock` per height (2
    // RPCs × 1 block), which dominated wallclock during backfill.
    //
    // Parsed blocks accumulate in a `pending` buffer and flush to CH
    // in groups of `BACKFILL_TX_BATCH_SIZE` via `applyBlocks` — one
    // fsync per group instead of per block.
    //
    // All state + closures live in BackfillJob below so this method
    // can stay small. Concurrency + fetch span come from
    // `adaptiveLimits` per pump step (not captured once) so AIMD stress
    // events take effect on the next batch issued.
    const txBatchSize = Math.max(1, config.BACKFILL_TX_BATCH_SIZE);
    const job = new BackfillJob({
      from,
      to,
      tipHeight,
      txBatchSize,
      isAborted: () => this.aborted,
    });
    await job.run();
  }
}

interface BackfillJobOptions {
  from: number;
  to: number;
  tipHeight: number;
  txBatchSize: number;
  isAborted: () => boolean;
}

/**
 * Single processRange execution. Owns the fetcher + writer pipeline
 * state across one walk of `[from, to]`. State is private, the
 * lifetime is a single `run()` call, and `isAborted()` reads through
 * to the parent backfiller so a cross-run shutdown propagates.
 *
 * Per-run `wipeAborted` flag is internal: a wipe-driven abort during
 * this run mustn't bleed into the next run (the parent's `aborted` is
 * never cleared, so it can't carry per-run state).
 */
class BackfillJob {
  private readonly from: number;

  private readonly to: number;

  private readonly tipHeight: number;

  private readonly txBatchSize: number;

  private readonly isAborted: () => boolean;

  private readonly blocks = new Map<number, VerboseBlock>();

  private readonly pending: ParsedBlock[] = [];

  private nextToWrite: number;

  private nextToFetch: number;

  private inFlight = 0;

  private draining = false;

  private wipeAborted = false;

  // Resolve/reject of the run() promise. Set in run() before any
  // closures fire; non-null inside the closures by construction.
  private settle?: { resolve: () => void; reject: (err: unknown) => void };

  constructor(opts: BackfillJobOptions) {
    this.from = opts.from;
    this.to = opts.to;
    this.tipHeight = opts.tipHeight;
    this.txBatchSize = opts.txBatchSize;
    this.isAborted = opts.isAborted;
    this.nextToWrite = opts.from;
    this.nextToFetch = opts.from;
  }

  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.pump();
    });
  }

  private async flushPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const group = this.pending.splice(0, this.pending.length);
    // Full SSE firehose during backfill: every block.new, address-
    // and cpid-keyed events fire per committed block, exactly like
    // live tip-following. RAF-coalescing in the burst-prone panels
    // (LiveBlockTicker, TxsPerBlockChart) collapses the storm into
    // one re-render per animation frame on the frontend.
    //
    // `deferPostCommit: true` lets the drain return as soon as the
    // CH inserts commit; SSE publishes + Meili enqueue for this batch
    // run in the background while drain starts parsing the next.
    await applyBlocks(group, { emitLiveEvents: true, deferPostCommit: true });

    const lastHeight = group[group.length - 1].block.height;
    const pct = this.tipHeight > 0 ? (lastHeight / this.tipHeight) * 100 : 0;
    events.publish({
      topic: 'backfill.progress',
      payload: { height: lastHeight, tip: this.tipHeight, pct },
    });
    if (lastHeight % 10_000 < group.length) {
      log.info(`Backfill progress: ${lastHeight}/${this.tipHeight} (${pct.toFixed(2)}%)`);
    }
  }

  private async drain(): Promise<void> {
    // Re-entrancy guard: drain() may be invoked from multiple
    // fetchSpanCall completions; if one is already running, let it
    // pick up the newly-arrived block on its next loop iteration.
    if (this.draining) return;
    if (this.wipeAborted) return;
    this.draining = true;
    try {
      while (this.blocks.has(this.nextToWrite)) {
        // Wipe coordination: between batches is a safe point to bail
        // so the wipe can DROP DATABASE without racing an in-flight
        // applyBlocks. Setting wipeAborted gates both this drain (no
        // more flushPending) AND the fetcher pump (no more
        // fetchSpanCall) so orphaned in-flight RPC fetches that land
        // after the wipe completes don't sneak rows into the
        // freshly-recreated tables.
        // eslint-disable-next-line no-await-in-loop
        if (await isWipeInProgress()) {
          log.info('HistoricalBackfiller: wipe in progress, aborting drain');
          this.wipeAborted = true;
          this.settle?.resolve();
          return;
        }
        // Collect up to `txBatchSize` consecutive raw blocks first,
        // then resolve all their prev_outputs in one SELECT, then
        // parse them with the shared lookup. This collapses N
        // tx_outputs SELECTs (one per block) into one per batch — a
        // significant per-batch saving on a large `txBatchSize`.
        const rawGroup: VerboseBlock[] = [];
        while (this.blocks.has(this.nextToWrite) && rawGroup.length < this.txBatchSize) {
          const block = this.blocks.get(this.nextToWrite)!;
          this.blocks.delete(this.nextToWrite);
          rawGroup.push(block);
          this.nextToWrite += 1;
          if (this.nextToWrite > this.to) break;
        }
        if (rawGroup.length === 0) break;
        // Pass `pending`'s outputs into the lookup so a vin in this
        // rawGroup can resolve against a previous group that's been
        // parsed but not yet flushed to CH. The alternative —
        // force-flush before every new lookup — would lose the
        // txBatchSize batching benefit.
        const parsedPendingOutputs = this.pending.flatMap((p) => p.txOutputs);
        // eslint-disable-next-line no-await-in-loop
        const lookup = await buildPrevOutputsLookupMulti(
          rawGroup.map((b) => b.tx),
          parsedPendingOutputs,
        );
        for (const block of rawGroup) {
          this.pending.push(parseBlock(block, lookup));
        }
        // Flush either when the group is full or when we've reached
        // the end of the range — never leave un-applied blocks behind.
        if (this.pending.length >= this.txBatchSize || this.nextToWrite > this.to) {
          // eslint-disable-next-line no-await-in-loop
          await this.flushPending();
        }
      }
      // Eager-flush hatch: if there's no other RPC in flight and we
      // still have parsed blocks waiting, commit them now even if
      // `pending` hasn't reached `txBatchSize`. With adaptive limits
      // at the floor (concurrency=1, span=1) the inner flush trigger
      // never fires — we'd accumulate a single block per call and
      // never reach 50 — so progress would stall indefinitely. With
      // concurrency at the ceiling and calls overlapping, `inFlight`
      // stays >0 between drains and the regular txBatchSize trigger
      // amortizes commits as before. Pure win for stressed-mode
      // operation, no cost in healthy-mode operation.
      if (this.pending.length > 0 && this.inFlight === 0 && !this.isAborted() && !this.wipeAborted) {
        await this.flushPending();
      }
      // Resolve when either (a) we've fully finished the range or
      // (b) we've been aborted and the fetcher pipeline has emptied.
      // The aborted branch flushes whatever is already parsed so we
      // don't lose progress on shutdown — pending fetches are
      // discarded since their results would land on a closed range.
      const finished = this.nextToWrite > this.to && this.inFlight === 0 && this.nextToFetch > this.to;
      const stopped = this.isAborted() && this.inFlight === 0;
      if (finished || stopped) {
        await this.flushPending();
        this.settle?.resolve();
      }
    } catch (err) {
      this.settle?.reject(err);
    } finally {
      this.draining = false;
    }
  }

  // Fetch a span of `count` consecutive blocks starting at `start`
  // in one RPC. Daemon serializer for `getblocksbatch` returns
  // `{ block_count, blocks: [...] }`; gridcoin-rpc camelCases keys
  // deeply, so on the wire it's `{ blockCount, blocks }`. We key the
  // buffer Map off response.height, not the request, so a daemon
  // under-fill (we ran past tip mid-flight, transient hiccup) lands
  // partials correctly and the missing trailing heights get
  // re-requested by `pump` on the next pass.
  private async fetchSpanCall(start: number, count: number): Promise<void> {
    this.inFlight += 1;
    try {
      const result = await heavyRpc.getBlocksBatch(start, count, true);
      const got = Array.isArray(result?.blocks)
        ? (result.blocks as unknown as VerboseBlock[])
        : [];
      for (const block of got) {
        if (typeof block?.height === 'number') {
          this.blocks.set(block.height, block);
        }
      }
      // Rewind nextToFetch on daemon under-fill so the next pump
      // retries the missing tail. Forward-only buffer keys off
      // response.height, so rewinding is safe (no duplicate keys).
      if (got.length < count) {
        const missingFrom = (got[got.length - 1]?.height ?? (start - 1)) + 1;
        if (missingFrom < this.nextToFetch) this.nextToFetch = missingFrom;
      }
    } catch (err) {
      this.settle?.reject(err);
      return;
    } finally {
      this.inFlight -= 1;
    }
    await this.drain();
    // Cooldown so the daemon's `cs_main` is released long enough
    // between batches for the shared wallet's other clients
    // (stamp's `getbalance`, daemon-side ConnectBlock for new p2p
    // blocks) to acquire it. Without this, low concurrency alone
    // doesn't help — pipelined batches keep the daemon continuously
    // busy.
    if (config.BACKFILL_BATCH_DELAY_MS > 0) {
      await new Promise<void>((r) => {
        setTimeout(r, config.BACKFILL_BATCH_DELAY_MS);
      });
    }
    this.pump();
  }

  private pump(): void {
    if (this.isAborted() || this.wipeAborted) return;
    // Read AIMD's current limits per pump step so a stress event
    // mid-run takes effect immediately on the next batch issued. Old
    // in-flight calls drain naturally; we just stop spawning new ones
    // once we hit the (possibly halved) ceiling.
    const concurrency = adaptiveLimits.getConcurrency();
    const fetchSpan = adaptiveLimits.getFetchSpan();
    while (this.inFlight < concurrency && this.nextToFetch <= this.to) {
      const start = this.nextToFetch;
      const remaining = this.to - start + 1;
      const count = Math.min(fetchSpan, remaining);
      this.nextToFetch += count;
      this.fetchSpanCall(start, count).catch((err) => this.settle?.reject(err));
    }
  }
}
