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
    const info = await (liveRpc as unknown as { getBlockchainInfo: () => Promise<{ blocks: number }> })
      .getBlockchainInfo();
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

      const result = await (simpleRpc as unknown as {
        getBlocksBatch: <T extends boolean>(
          start: number,
          n: number,
          txinfo: T,
        ) => Promise<{ blockCount: number; blocks: VerboseBlock[] }>;
      }).getBlocksBatch(height, 1, true);
      const block = result?.blocks?.[0];
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
    // Once parsed, blocks accumulate in a `pending` buffer; we flush
    // them to MySQL in groups of `BACKFILL_TX_BATCH_SIZE` via
    // `applyBlocks`, which puts the whole group inside one interactive
    // transaction. A single fsync per group instead of per block is
    // the dominant backfill speedup on Docker filesystems.
    // concurrency + fetchSpan come from `adaptiveLimits` per pump
    // step rather than being captured once here. AIMD halves them on
    // daemon stress and ramps them back on success — capturing them
    // would freeze the run at whatever value happened to apply when
    // processRange started, defeating the controller. Daemon caps
    // `getblocksbatch` at 1000; the AIMD ceiling is config.BACKFILL_FETCH_SPAN
    // which is itself bounded by sane defaults, so no clamp needed here.
    const txBatchSize = Math.max(1, config.BACKFILL_TX_BATCH_SIZE);
    const blocks = new Map<number, VerboseBlock>();
    const pending: ParsedBlock[] = [];
    let nextToWrite = from;
    let nextToFetch = from;
    let inFlight = 0;
    let draining = false;
    // Per-run flag so a wipe-driven abort doesn't bleed into the *next*
    // processRange call (this.aborted is reserved for cross-run shutdown
    // and never cleared, which would freeze the next run forever).
    // Once flipped: the fetcher stops spawning new RPCs, drain()
    // short-circuits, and orphaned in-flight fetchOne callbacks land
    // their buffered blocks into the discarded `blocks` Map without
    // writing them — the next processRange reads a fresh cursor (null
    // post-wipe) and starts from genesis with empty buffers.
    let wipeAborted = false;

    return new Promise<void>((resolve, reject) => {
      const flushPending = async (): Promise<void> => {
        if (pending.length === 0) return;
        const group = pending.splice(0, pending.length);
        // Full SSE firehose during backfill: every block.new,
        // address.<addr>.balance, cpid.<cpid>.magnitude, and
        // metrics.tick fires for each committed block, exactly like
        // live tip-following. The frontend's RAF-coalescing in the
        // burst-prone panels (LiveBlockTicker, TxsPerBlockChart)
        // collapses the storm into one re-render per animation frame.
        // Server-side cost: per-block metrics.tick does an extra
        // metric_buckets findUnique × 2 granularities, so ~200 reads
        // per batch of 100 blocks. Worth it for the live feel.
        // `deferPostCommit: true` lets drain return as soon as the DB
        // tx commits — SSE publishes + Meili enqueue for *this* batch
        // run in the background while drain starts parsing the *next*
        // batch. The two never share state: post-commit only reads
        // (metric_buckets cache) and writes Redis/SSE; the next
        // applyBlocks owns its own Prisma tx. Net effect: the
        // user-visible "delay between batches" collapses to just the
        // fsync.
        await applyBlocks(group, { emitLiveEvents: true, deferPostCommit: true });

        const lastHeight = group[group.length - 1].block.height;
        const pct = tipHeight > 0 ? (lastHeight / tipHeight) * 100 : 0;
        events.publish({
          topic: 'backfill.progress',
          payload: { height: lastHeight, tip: tipHeight, pct },
        });
        if (lastHeight % 10_000 < group.length) {
          log.info(`Backfill progress: ${lastHeight}/${tipHeight} (${pct.toFixed(2)}%)`);
        }
      };

      const drain = async () => {
        // Re-entrancy guard: drain may be invoked from multiple fetchOne
        // completions; if one is already running, let it pick up the
        // newly-arrived block on its next loop iteration.
        if (draining) return;
        if (wipeAborted) return;
        draining = true;
        try {
          while (blocks.has(nextToWrite)) {
            // Wipe coordination: between batches is a safe point to bail
            // out so the wipe can DROP DATABASE without racing an
            // in-flight applyBlocks. Setting wipeAborted gates both this
            // drain (no more flushPending) AND the fetcher pump (no more
            // fetchOne calls), so orphaned in-flight RPC fetches that
            // land after the wipe completes don't sneak rows into the
            // freshly-recreated tables.
            // eslint-disable-next-line no-await-in-loop
            if (await isWipeInProgress()) {
              log.info('HistoricalBackfiller: wipe in progress, aborting drain');
              wipeAborted = true;
              resolve();
              return;
            }
            // Collect up to `txBatchSize` consecutive raw blocks first,
            // then resolve all their prev_outputs in one SELECT, then
            // parse them with the shared lookup. This collapses N
            // tx_outputs SELECTs (one per block) into one per batch —
            // a significant per-batch saving on a large `txBatchSize`.
            const rawGroup: VerboseBlock[] = [];
            while (blocks.has(nextToWrite) && rawGroup.length < txBatchSize) {
              const block = blocks.get(nextToWrite)!;
              blocks.delete(nextToWrite);
              rawGroup.push(block);
              nextToWrite += 1;
              if (nextToWrite > to) break;
            }
            if (rawGroup.length === 0) break;
            // Pass `pending`'s outputs into the lookup so a vin in
            // this rawGroup can resolve against a previous group
            // that's been parsed but not yet flushed to CH. The
            // alternative — force-flush before every new lookup —
            // would lose the txBatchSize batching benefit.
            const parsedPendingOutputs = pending.flatMap((p) => p.txOutputs);
            // eslint-disable-next-line no-await-in-loop
            const lookup = await buildPrevOutputsLookupMulti(
              rawGroup.map((b) => b.tx),
              parsedPendingOutputs,
            );
            for (const block of rawGroup) {
              pending.push(parseBlock(block, lookup));
            }
            // Flush either when the group is full or when we've reached
            // the end of the range — never leave un-applied blocks behind.
            if (pending.length >= txBatchSize || nextToWrite > to) {
              // eslint-disable-next-line no-await-in-loop
              await flushPending();
            }
          }
          // Eager-flush hatch: if there's no other RPC in flight and
          // we still have parsed blocks waiting, commit them now even
          // if `pending` hasn't reached `txBatchSize`. With adaptive
          // limits at the floor (concurrency=1, span=1) the inner
          // flush trigger never fires — we'd accumulate a single
          // block per call and never reach 50 — so progress would
          // stall indefinitely. With concurrency at the ceiling and
          // calls overlapping, `inFlight` stays >0 between drains and
          // the regular txBatchSize trigger amortizes commits as
          // before. Pure win for stressed-mode operation, no cost in
          // healthy-mode operation.
          if (pending.length > 0 && inFlight === 0 && !this.aborted && !wipeAborted) {
            await flushPending();
          }
          // Resolve when either (a) we've fully finished the range or
          // (b) we've been aborted and the fetcher pipeline has emptied.
          // The aborted branch flushes whatever is already parsed so we
          // don't lose progress on shutdown — pending fetches are
          // discarded since their results would land on a closed range.
          const finished = nextToWrite > to && inFlight === 0 && nextToFetch > to;
          const stopped = this.aborted && inFlight === 0;
          if (finished || stopped) {
            await flushPending();
            resolve();
          }
        } catch (err) {
          reject(err);
        } finally {
          draining = false;
        }
      };

      // Fetch a span of `count` consecutive blocks starting at
      // `start` in one RPC. Daemon serializer for `getblocksbatch`
      // returns `{ block_count, blocks: [...] }`; the gridcoin-rpc
      // client camelCases keys deeply, so on the wire it's
      // `{ blockCount, blocks }`. Each block has its own `height` so
      // we key the buffer Map off the response, not the request — if
      // the daemon ever returns fewer blocks than asked (we ran past
      // tip mid-flight), partial results land correctly and the
      // missing trailing heights get re-requested by `pump` on the
      // next pass.
      const fetchSpanCall = async (start: number, count: number) => {
        inFlight += 1;
        try {
          const result = await (heavyRpc as unknown as {
            getBlocksBatch: <T extends boolean>(
              start: number, n: number, txinfo: T,
            ) => Promise<{ blockCount: number; blocks: VerboseBlock[] }>;
          }).getBlocksBatch(start, count, true);
          const got = Array.isArray(result?.blocks) ? result.blocks : [];
          for (const block of got) {
            if (typeof block?.height === 'number') {
              blocks.set(block.height, block);
            }
          }
          // Defensive: if the daemon under-fills the response (last span
          // running past tip, or a transient daemon hiccup), `nextToFetch`
          // already advanced past these heights — rewind it so the next
          // pump retries the missing tail. The forward-only buffer keys
          // off response.height, so rewinding is safe (no duplicate keys).
          if (got.length < count) {
            const missingFrom = (got[got.length - 1]?.height ?? (start - 1)) + 1;
            if (missingFrom < nextToFetch) nextToFetch = missingFrom;
          }
        } catch (err) {
          reject(err);
          return;
        } finally {
          inFlight -= 1;
        }
        await drain();
        // Cooldown so the daemon's `cs_main` is released long enough
        // between batches for the shared wallet's other clients
        // (stamp's `getbalance`, daemon-side ConnectBlock for new
        // p2p blocks) to acquire it. Without this, low concurrency
        // alone doesn't help — pipelined batches keep the daemon
        // continuously busy.
        if (config.BACKFILL_BATCH_DELAY_MS > 0) {
          await new Promise<void>((r) => {
            setTimeout(r, config.BACKFILL_BATCH_DELAY_MS);
          });
        }
        // pump and fetchSpanCall form a mutually-recursive closure pair;
        // declare-then-define here is intentional and safe (TDZ has
        // resolved by the time the await above completes).
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        pump();
      };

      const pump = () => {
        if (this.aborted || wipeAborted) return;
        // Read AIMD's current limits per pump step so a stress event
        // mid-run takes effect immediately on the next batch issued.
        // Old in-flight calls drain naturally; we just stop spawning
        // new ones once we hit the (possibly halved) ceiling.
        const concurrency = adaptiveLimits.getConcurrency();
        const fetchSpan = adaptiveLimits.getFetchSpan();
        while (inFlight < concurrency && nextToFetch <= to) {
          const start = nextToFetch;
          const remaining = to - start + 1;
          const count = Math.min(fetchSpan, remaining);
          nextToFetch += count;
          fetchSpanCall(start, count).catch(reject);
        }
      };

      pump();
    });
  }
}
