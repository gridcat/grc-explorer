import { ch } from '../../lib/ch';
import { events } from '../../lib/emitter';
import { getTipAnchor } from '../../lib/indexerTip';
import { log } from '../../lib/log';
import { positiveBalancesDesc } from '../../lib/redis';

// Daily wealth snapshot. One row per UTC-day bucket into the
// `wealth_snapshots` CH table. The dashboard's wealth-distribution
// panel + Lorenz / top-N share series read from there.
//
// Each tick:
//   1. Finds the indexer tip's UTC-day bucket and any missing buckets
//      between the last-written one (or chain-genesis day) and that.
//   2. For each missing bucket, reads `address_balance_history` AT the
//      bucket's chain height to reconstruct per-address balances at
//      that instant, then derives gini, top-N concentration shares,
//      active/new/hodler counts.
//   3. Inserts everything in one batch and stops when either the queue
//      drains or we hit MAX_BACKFILL_PER_TICK (so a fresh genesis-to-tip
//      run doesn't camp on CH for an hour straight).
//
// Why CH and not the Redis wallet ZSET: the ZSET reflects "now" only,
// so it can't answer historical queries. address_balance_history is
// height-keyed (sum(delta) over rows with valid_from_height <= H gives
// balance at H) and is rewritable safely on reorg — exactly what we
// need for "what did the distribution look like on 2018-04-17". The
// trade-off is per-bucket scan cost; ordering by (address, valid_from_height)
// and the bounded address universe (~50k Gridcoin holders) keeps the
// scan well under a second on a healthy CH.
//
// Idempotency: ReplacingMergeTree(_seq) on `wealth_snapshots` collapses
// duplicate bucket rows naturally, so concurrent re-writes (replays,
// reorgs) heal to the latest version without manual cleanup.

// Effectively uncapped: one tick drains every remaining missing
// bucket in a single pass (schedule()'s single-flight guard prevents
// overlapping ticks). Lower this to re-throttle to N buckets/tick.
const MAX_BACKFILL_PER_TICK = 1_000_000;

// Skip buckets older than the first chain block (no addresses, no
// balances — the math would just emit zeros).
const CHAIN_GENESIS_DAY = (() => {
  const GRIDCOIN_GENESIS_TS = 1413033777; // 2014-10-11 14:42:57 UTC
  return Math.floor(GRIDCOIN_GENESIS_TS / 86_400) * 86_400;
})();

interface SnapshotRow {
  bucketTs: number;
  totalSupply: string;
  addressesWithBalance: number;
  gini: number;
  top1pctShare: number;
  top10pctShare: number;
  top100Share: number;
  active24h: number;
  new24h: number;
  hodler30d: number;
  hodler180d: number;
}

export class WealthSnapshotJob {
  async tick(): Promise<void> {
    try {
      const anchor = await getTipAnchor();
      if (!Number.isFinite(anchor) || anchor <= 0) return;
      const currentBucket = Math.floor(anchor / 86_400) * 86_400;

      const existing = await this.writtenBuckets();

      // Build the backfill batch in two passes so the chart's right
      // edge populates quickly:
      //   1) Front-load the *current* bucket and the previous few days
      //      — what the dashboard renders by default.
      //   2) Forward-fill from chain genesis so the historical series
      //      fills in chronologically on subsequent ticks.
      // ReplacingMergeTree isn't configured for wealth_snapshots, so
      // we strictly avoid duplicate writes by checking against
      // `existing` before queuing each candidate.
      const queued = new Set<number>();
      const missing: number[] = [];
      const queue = (bt: number): boolean => {
        if (bt < CHAIN_GENESIS_DAY || bt > currentBucket) return false;
        if (existing.has(bt) || queued.has(bt)) return false;
        queued.add(bt);
        missing.push(bt);
        return missing.length < MAX_BACKFILL_PER_TICK;
      };
      for (let i = 0; i < 7; i += 1) {
        if (!queue(currentBucket - i * 86_400)) break;
      }
      for (
        let bt = CHAIN_GENESIS_DAY;
        bt <= currentBucket && missing.length < MAX_BACKFILL_PER_TICK;
        bt += 86_400
      ) {
        queue(bt);
      }
      if (missing.length === 0) return; // up to date

      missing.sort((a, b) => a - b);

      const written: SnapshotRow[] = [];
      for (const bucketTs of missing) {
        // eslint-disable-next-line no-await-in-loop
        const row = await this.computeSnapshot(bucketTs, bucketTs === currentBucket);
        if (row !== null) written.push(row);
      }

      if (written.length > 0) {
        await ch.insert({
          table: 'wealth_snapshots',
          format: 'JSONEachRow',
          values: written.map((r) => ({
            bucket_ts: r.bucketTs,
            total_supply: r.totalSupply,
            addresses_with_balance: r.addressesWithBalance,
            gini: r.gini.toFixed(8),
            top1pct_share: r.top1pctShare.toFixed(8),
            top10pct_share: r.top10pctShare.toFixed(8),
            top100_share: r.top100Share.toFixed(8),
            active_24h: r.active24h,
            new_24h: r.new24h,
            hodler_30d: r.hodler30d,
            hodler_180d: r.hodler180d,
          })),
        });
        log.info(`WealthSnapshot: wrote ${written.length} bucket(s); first=${written[0].bucketTs}, last=${written[written.length - 1].bucketTs}`);
        // SSE fanout so the dashboard's WealthDistributionChart refreshes
        // exactly when there's new data, instead of polling at block
        // cadence. Latest bucket is what the chart's right edge renders.
        try {
          events.publish({
            topic: 'wealth.snapshot',
            payload: { bucket_ts: written[written.length - 1].bucketTs },
          });
        } catch (err) {
          log.warn('WealthSnapshotJob: SSE fanout failed', err);
        }
      }
    } catch (err) {
      log.warn('WealthSnapshotJob.tick failed', err);
    }
  }

  private async writtenBuckets(): Promise<Set<number>> {
    const r = await ch.query({
      query: 'SELECT DISTINCT toUnixTimestamp(bucket_ts) AS bt FROM wealth_snapshots',
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ bt: number }>();
    const set = new Set<number>();
    for (const row of rows) {
      if (typeof row.bt === 'number' && row.bt > 0) set.add(row.bt);
    }
    return set;
  }

  private async heightAtTime(ts: number): Promise<number | null> {
    const r = await ch.query({
      // No FINAL: max(height) is unaffected by un-merged duplicate
      // block rows (same height), and dropping it lets the
      // idx_blocks_time minmax index prune `time <= X`. Empty match
      // yields max()=0, which the caller already maps to null.
      query: `
        SELECT max(height) AS h FROM blocks
        WHERE time <= toDateTime({at: UInt32})
      `,
      query_params: { at: ts },
      format: 'JSONEachRow',
    });
    const row = (await r.json<{ h: number | null }>())[0];
    return row?.h ?? null;
  }

  // Build one wealth_snapshots row for `bucketTs`. Returns null when
  // the chain hadn't reached this UTC day yet (block-time gap) or no
  // address state is reconstructable from history.
  private async computeSnapshot(
    bucketTs: number,
    isCurrent: boolean,
  ): Promise<SnapshotRow | null> {
    const heightAtBucket = await this.heightAtTime(bucketTs);
    if (heightAtBucket === null || heightAtBucket === 0) return null;

    // Total supply at this height. money_supply is a running counter
    // maintained by BlockWriter, so the max() over blocks at-or-before
    // the cutoff equals the supply at that height.
    const supplyResult = await ch.query({
      // No FINAL: money_supply is a monotonic per-height counter, so
      // max() over the `height <= h` (PK-pruned) range is unaffected
      // by un-merged duplicate rows; FINAL would only add a full
      // merge-scan.
      query: `
        SELECT toString(max(money_supply)) AS supply
        FROM blocks
        WHERE height <= {h: UInt32}
      `,
      query_params: { h: heightAtBucket },
      format: 'JSONEachRow',
    });
    const totalSupply = BigInt(
      (await supplyResult.json<{ supply: string | null }>())[0]?.supply ?? '0',
    );

    // Reconstruct positive-balance set at this height. We pull the
    // sorted-descending balance array back to JS so we can compute
    // gini and top-N shares without a second CH pass. The array is
    // bounded by the number of distinct holders (~50k on mainnet),
    // which is comfortably small for one round trip.
    //
    // Float64 truncation: a halford-precision balance fits in ~53 bits
    // of mantissa as long as it's under ~9e15 (90 million GRC). The
    // top mainnet wallet sits around a few million GRC — three orders
    // of magnitude clear. We accept the precision loss for the
    // ordering / sum / share calculations that only need ratios; the
    // result is identical to the prior Redis ZSET path which also
    // stored scores as f64.
    let balances: number[];
    if (isCurrent) {
      // Steady-state: current balances live in Redis
      // (wallets:by_balance), maintained per-block by the indexer.
      // Replaces a per-tick 20M-row address_balance_history FINAL
      // scan. The ≤1-day skew vs the bucket's start-of-day height is
      // the long-standing accepted behaviour for the live bucket;
      // historical buckets still reconstruct exactly from CH below.
      balances = await positiveBalancesDesc();
    } else {
      const balancesResult = await ch.query({
        query: `
          SELECT arrayReverseSort(groupArray(toFloat64(balance))) AS sorted
          FROM (
            SELECT address, sum(delta) AS balance
            FROM address_balance_history FINAL
            WHERE valid_from_height <= {h: UInt32} AND address != ''
            GROUP BY address
            HAVING balance > 0
          )
        `,
        query_params: { h: heightAtBucket },
        format: 'JSONEachRow',
      });
      const sortedRow = (await balancesResult.json<{ sorted: number[] }>())[0];
      balances = Array.isArray(sortedRow?.sorted) ? sortedRow.sorted : [];
    }
    const n = balances.length;
    const totalBal = balances.reduce((acc, b) => acc + b, 0);

    const topShare = (count: number): number => {
      if (totalBal === 0 || n === 0) return 0;
      const slice = balances.slice(0, Math.min(count, n));
      return slice.reduce((acc, b) => acc + b, 0) / totalBal;
    };
    const top1pctShare = topShare(Math.max(1, Math.ceil(n / 100)));
    const top10pctShare = topShare(Math.max(1, Math.ceil(n / 10)));
    const top100Share = topShare(100);

    // Standard gini from a descending-sorted array. The formula
    //   gini = (2 * Σ(rank_asc * x_i) − (n+1) * Σx_i) / (n * Σx_i)
    // wants ascending ranks; flipping the sign converts our descending
    // sort cheaper than re-iterating.
    let gini = 0;
    if (n > 0 && totalBal > 0) {
      let weightedSum = 0;
      for (let i = 0; i < n; i += 1) {
        weightedSum += (i + 1) * balances[i];
      }
      gini = -(2 * weightedSum - (n + 1) * totalBal) / (n * totalBal);
    }

    // Cutoff heights for active / hodler windows, anchored on the
    // BUCKET time (not wall-clock). Resolve the three distinct
    // cutoffs first (24h is shared between active+new) so the four
    // downstream counts can fire as a real 4-way parallel without
    // each branch doing its own height lookup.
    const [h24, h30, h180] = await Promise.all([
      this.heightAtTime(bucketTs - 86_400),
      this.heightAtTime(bucketTs - 30 * 86_400),
      this.heightAtTime(bucketTs - 180 * 86_400),
    ]);
    const [active24h, new24h, hodler30d, hodler180d] = await Promise.all([
      h24 === null ? 0 : this.activeCountAt(heightAtBucket, h24),
      h24 === null ? 0 : this.newAddressCountAt(heightAtBucket, h24),
      h30 === null ? 0 : this.hodlerCountAt(heightAtBucket, h30),
      h180 === null ? 0 : this.hodlerCountAt(heightAtBucket, h180),
    ]);

    return {
      bucketTs,
      totalSupply: totalSupply.toString(),
      addressesWithBalance: n,
      gini,
      top1pctShare,
      top10pctShare,
      top100Share,
      active24h,
      new24h,
      hodler30d,
      hodler180d,
    };
  }

  private async activeCountAt(heightAtBucket: number, cutoffHeight: number): Promise<number> {
    const r = await ch.query({
      query: `
        SELECT count(DISTINCT address) AS c
        FROM address_balance_history
        WHERE valid_from_height > {lo: UInt32}
          AND valid_from_height <= {hi: UInt32}
          AND address != ''
      `,
      query_params: { lo: cutoffHeight, hi: heightAtBucket },
      format: 'JSONEachRow',
    });
    return Number((await r.json<{ c: number | string }>())[0]?.c ?? 0);
  }

  private async newAddressCountAt(heightAtBucket: number, cutoffHeight: number): Promise<number> {
    const r = await ch.query({
      query: `
        SELECT count() AS c FROM (
          SELECT address, min(valid_from_height) AS first_seen
          FROM address_balance_history FINAL
          WHERE address != '' AND valid_from_height <= {hi: UInt32}
          GROUP BY address
          HAVING first_seen > {lo: UInt32}
        )
      `,
      query_params: { lo: cutoffHeight, hi: heightAtBucket },
      format: 'JSONEachRow',
    });
    return Number((await r.json<{ c: number | string }>())[0]?.c ?? 0);
  }

  private async hodlerCountAt(heightAtBucket: number, cutoffHeight: number): Promise<number> {
    // Hodler = currently positive balance AND last balance-changing
    // event at-or-before the cutoff. `max(valid_from_height)` picks
    // the address's most recent state change.
    const r = await ch.query({
      query: `
        SELECT count() AS c FROM (
          SELECT
            address,
            sum(delta)             AS balance,
            max(valid_from_height) AS last_seen
          FROM address_balance_history FINAL
          WHERE address != '' AND valid_from_height <= {hi: UInt32}
          GROUP BY address
          HAVING balance > 0 AND last_seen <= {lo: UInt32}
        )
      `,
      query_params: { lo: cutoffHeight, hi: heightAtBucket },
      format: 'JSONEachRow',
    });
    return Number((await r.json<{ c: number | string }>())[0]?.c ?? 0);
  }
}
