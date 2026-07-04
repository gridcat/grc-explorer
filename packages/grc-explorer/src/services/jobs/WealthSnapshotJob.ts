import { query, upsert } from '../../lib/db';
import { positiveBalancesDesc } from '../../lib/addressState';
import { events } from '../../lib/emitter';
import { getTipAnchor } from '../../lib/indexerTip';
import { log } from '../../lib/log';

// Daily wealth snapshot. One row per UTC-day bucket into the
// `wealth_snapshots` table. The dashboard's wealth-distribution
// panel + Lorenz / top-N share series read from there.
//
// A bucket's row is the chain state at the bucket's 00:00 UTC boundary
// (heights resolved from block times), matching the original
// semantics: `active_24h`/`new_24h` describe the day BEFORE the
// boundary, hodler windows look 30/180 days back from it.
//
// Two computation paths, picked by gap size:
//
//   STREAMING (gap > DIFFERENTIAL_MAX buckets — genesis backfill, or
//   prod after a very long outage): ONE chronological walk over
//   address_balance_history via idx_abh_height, maintaining an
//   in-memory Map<address, {balance, firstSeen, lastSeen}> and
//   emitting a row at each day boundary. Replaces the old
//   per-bucket recomputation, which ran ~4 full scans of the 15.9M-row
//   event log per bucket × ~4,300 buckets and camped on the database
//   for days. Peak memory ≈ a few hundred MB for ~1.5M addresses
//   (exact bigint balances — better than the old CAST(... AS DOUBLE)).
//
//   DIFFERENTIAL (gap ≤ DIFFERENTIAL_MAX — the steady prod path after
//   an outage): per missing bucket, reconstruct balances at the
//   boundary BACKWARDS from the address_state projection minus the
//   deltas that landed after it (small idx_abh_height range scans),
//   with per-address last_seen corrections for the adjusted set.
//
// The CURRENT bucket keeps the long-standing shortcut: balance
// magnitudes come from address_state's live positives (≤1-day skew
// accepted); the activity counts still use the boundary heights.
//
// Idempotency: bucket_ts is the PRIMARY KEY, so the upsert overwrites
// a bucket's row in place — replays and reorg re-runs heal to the
// latest version without manual cleanup.

const DAY = 86_400;

// Gaps at or below this many missing buckets use the differential
// path; anything larger falls back to one streaming walk.
const DIFFERENTIAL_MAX = 30;

// Streaming pass: buffer this many finished buckets per upsert.
const UPSERT_BATCH = 50;

// Skip buckets older than the first chain block (no addresses, no
// balances — the math would just emit zeros).
const CHAIN_GENESIS_DAY = (() => {
  const GRIDCOIN_GENESIS_TS = 1413033777; // 2014-10-11 14:42:57 UTC
  return Math.floor(GRIDCOIN_GENESIS_TS / DAY) * DAY;
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

interface AddressTrack {
  balance: bigint;
  firstSeen: number;
  lastSeen: number;
}

// Shares + gini from a DESCENDING-sorted positive balance array.
// Identical math to the original per-bucket implementation.
function distributionStats(balances: number[]): {
  gini: number; top1pctShare: number; top10pctShare: number; top100Share: number;
} {
  const n = balances.length;
  let totalBal = 0;
  for (const b of balances) totalBal += b;

  const topShare = (count: number): number => {
    if (totalBal === 0 || n === 0) return 0;
    let sum = 0;
    const upTo = Math.min(count, n);
    for (let i = 0; i < upTo; i += 1) sum += balances[i];
    return sum / totalBal;
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
  return {
    gini, top1pctShare, top10pctShare, top100Share,
  };
}

// Per-UTC-day chain geometry, computed once per streaming pass:
// bucket boundary heights (last block STRICTLY BEFORE the bucket's
// 00:00) + the money supply at each boundary.
interface DayBoundary {
  bucketTs: number;
  height: number; // boundary height; 0 = chain hadn't started
  supply: bigint; // money_supply at boundary (carried forward past NULLs)
}

export class WealthSnapshotJob {
  async tick(): Promise<void> {
    try {
      const anchor = await getTipAnchor();
      if (!Number.isFinite(anchor) || anchor <= 0) return;
      const currentBucket = Math.floor(anchor / DAY) * DAY;

      const existing = await this.writtenBuckets();
      const missing: number[] = [];
      for (let bt = CHAIN_GENESIS_DAY; bt <= currentBucket; bt += DAY) {
        if (!existing.has(bt)) missing.push(bt);
      }
      if (missing.length === 0) return;

      if (missing.length > DIFFERENTIAL_MAX) {
        log.info(`WealthSnapshot: ${missing.length} missing buckets — running streaming pass`);
        await this.streamingPass(existing, currentBucket);
      } else {
        // Newest-first so the chart's right edge heals before history.
        missing.sort((a, b) => b - a);
        const written: SnapshotRow[] = [];
        for (const bucketTs of missing) {
          // eslint-disable-next-line no-await-in-loop
          const row = await this.differentialSnapshot(bucketTs, bucketTs === currentBucket);
          if (row !== null) written.push(row);
        }
        await this.persist(written);
      }
    } catch (err) {
      log.warn('WealthSnapshotJob.tick failed', err);
    }
  }

  // ---------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------

  private async writtenBuckets(): Promise<Set<number>> {
    // UNIX_TIMESTAMP comes back as a decimal STRING through this
    // driver (bigNumberStrings/DECIMAL read contract) — coerce before
    // comparing. The retired implementation's `typeof === 'number'`
    // guard silently dropped every row, leaving `existing` empty, so
    // each tick restarted the genesis walk from scratch — a big part
    // of the "wealth job camps on the DB forever" symptom.
    const rows = await query<{ bt: number | string }>(
      'SELECT DISTINCT UNIX_TIMESTAMP(bucket_ts) AS bt FROM wealth_snapshots',
    );
    const set = new Set<number>();
    for (const row of rows) {
      const bt = Number(row.bt);
      if (Number.isFinite(bt) && bt > 0) set.add(bt);
    }
    return set;
  }

  private async persist(written: SnapshotRow[]): Promise<void> {
    if (written.length === 0) return;
    await upsert(
      'wealth_snapshots',
      written.map((r) => ({
        bucket_ts: r.bucketTs,
        total_supply: BigInt(r.totalSupply),
        addresses_with_balance: r.addressesWithBalance,
        gini: r.gini,
        top1pct_share: r.top1pctShare,
        top10pct_share: r.top10pctShare,
        top100_share: r.top100Share,
        active_24h: r.active24h,
        new_24h: r.new24h,
        hodler_30d: r.hodler30d,
        hodler_180d: r.hodler180d,
      })),
      { pk: ['bucket_ts'], tsCols: ['bucket_ts'] },
    );
    const first = written[0].bucketTs;
    const last = written[written.length - 1].bucketTs;
    log.info(`WealthSnapshot: wrote ${written.length} bucket(s); first=${first}, last=${last}`);
    // SSE fanout so the dashboard's WealthDistributionChart refreshes
    // exactly when there's new data, instead of polling at block
    // cadence. Latest bucket is what the chart's right edge renders.
    try {
      const newest = Math.max(first, last);
      events.publish({
        topic: 'wealth.snapshot',
        payload: { bucket_ts: newest },
      });
    } catch (err) {
      log.warn('WealthSnapshotJob: SSE fanout failed', err);
    }
  }

  // Boundary height + supply per UTC day, one pass over `blocks`.
  // boundary(D) = max height with time ≤ D·00:00 (the original
  // heightAtTime semantics — a block stamped exactly on midnight
  // belongs to the boundary), carried forward across empty days;
  // supply likewise carried past NULL money_supply. The -1s shift in
  // the grouping puts a t = X·00:00:00 block into the PREVIOUS group,
  // which is exactly what makes the group max equal the ≤ boundary.
  // Exposed for the parity script.
  async dayBoundaries(currentBucket: number): Promise<DayBoundary[]> {
    const perDay = await query<{ day: number | string; h: number | string }>(
      `
        SELECT ((UNIX_TIMESTAMP(time) - 1) DIV ${DAY}) * ${DAY} AS day, MAX(height) AS h
        FROM blocks
        GROUP BY day
      `,
    );
    const maxHeightInDay = new Map<number, number>();
    for (const r of perDay) maxHeightInDay.set(Number(r.day), Number(r.h));

    const heights = Array.from(maxHeightInDay.values());
    const supplyRows = heights.length === 0 ? [] : await query<{ height: number | string; s: string | null }>(
      'SELECT height, CAST(money_supply AS CHAR) AS s FROM blocks WHERE height IN ($hs)',
      { hs: heights },
    );
    const supplyAt = new Map<number, bigint>();
    for (const r of supplyRows) {
      if (r.s !== null) supplyAt.set(Number(r.height), BigInt(r.s));
    }

    const out: DayBoundary[] = [];
    let runHeight = 0;
    let runSupply = 0n;
    for (let bt = CHAIN_GENESIS_DAY; bt <= currentBucket; bt += DAY) {
      // Blocks of day (bt-DAY) are the last ones strictly before bt.
      const prevDayMax = maxHeightInDay.get(bt - DAY);
      if (prevDayMax !== undefined) {
        runHeight = prevDayMax;
        runSupply = supplyAt.get(prevDayMax) ?? runSupply;
      }
      out.push({ bucketTs: bt, height: runHeight, supply: runSupply });
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Streaming pass (large gaps / genesis backfill)
  // ---------------------------------------------------------------

  // One chronological walk over the event log. `onRow` intercepts rows
  // for the parity script; the default persists missing buckets.
  async streamingPass(
    existing: Set<number>,
    currentBucket: number,
    onRow?: (row: SnapshotRow) => void,
  ): Promise<void> {
    const bounds = await this.dayBoundaries(currentBucket);
    const boundaryAt = new Map<number, DayBoundary>();
    for (const b of bounds) boundaryAt.set(b.bucketTs, b);

    const state = new Map<string, AddressTrack>();
    const positives = new Set<string>();
    let buffer: SnapshotRow[] = [];

    let prevHeight = 0;
    for (const bound of bounds) {
      const isCurrent = bound.bucketTs === currentBucket;
      if (bound.height === 0) continue; // chain hadn't started

      // Apply the deltas between the previous boundary and this one.
      const touched = new Set<string>();
      if (bound.height > prevHeight) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await query<{ address: string; h: number | string; d: string }>(
          `
            SELECT address, valid_from_height AS h, CAST(delta AS CHAR) AS d
            FROM address_balance_history
            WHERE valid_from_height > $lo AND valid_from_height <= $hi
              AND address != ''
          `,
          { lo: prevHeight, hi: bound.height },
        );
        for (const r of rows) {
          const h = Number(r.h);
          const delta = BigInt(r.d);
          const track = state.get(r.address);
          if (track) {
            track.balance += delta;
            if (h > track.lastSeen) track.lastSeen = h;
            if (track.balance > 0n) positives.add(r.address);
            else positives.delete(r.address);
          } else {
            state.set(r.address, { balance: delta, firstSeen: h, lastSeen: h });
            if (delta > 0n) positives.add(r.address);
          }
          touched.add(r.address);
        }
        prevHeight = bound.height;
      }

      // Skip already-written buckets (state must still advance above).
      // The current bucket is left to the differential/live path, which
      // uses live balances for it (the accepted ≤1-day skew).
      if (existing.has(bound.bucketTs) || isCurrent) continue;

      const h24bound = boundaryAt.get(bound.bucketTs - DAY);
      const h30bound = boundaryAt.get(bound.bucketTs - 30 * DAY);
      const h180bound = boundaryAt.get(bound.bucketTs - 180 * DAY);
      const h24 = h24bound === undefined || h24bound.height === 0 ? null : h24bound.height;
      const h30 = h30bound === undefined || h30bound.height === 0 ? null : h30bound.height;
      const h180 = h180bound === undefined || h180bound.height === 0 ? null : h180bound.height;

      // active/new over the just-applied window; hodlers + distribution
      // over the (bounded, ~50k) positive set.
      const active24h = h24 === null ? 0 : touched.size;
      let new24h = 0;
      if (h24 !== null) {
        for (const a of touched) {
          const t = state.get(a);
          if (t && t.firstSeen > h24) new24h += 1;
        }
      }

      const balances: number[] = [];
      let hodler30d = 0;
      let hodler180d = 0;
      for (const a of positives) {
        const t = state.get(a) as AddressTrack;
        balances.push(Number(t.balance));
        if (h30 !== null && t.lastSeen <= h30) hodler30d += 1;
        if (h180 !== null && t.lastSeen <= h180) hodler180d += 1;
      }
      balances.sort((a, b) => b - a);

      buffer.push({
        bucketTs: bound.bucketTs,
        totalSupply: bound.supply.toString(),
        addressesWithBalance: balances.length,
        ...distributionStats(balances),
        active24h,
        new24h,
        hodler30d,
        hodler180d,
      });

      if (onRow) {
        onRow(buffer[buffer.length - 1]);
        buffer = [];
      } else if (buffer.length >= UPSERT_BATCH) {
        // eslint-disable-next-line no-await-in-loop
        await this.persist(buffer);
        buffer = [];
      }
    }
    if (!onRow) await this.persist(buffer);
  }

  // ---------------------------------------------------------------
  // Differential path (small gaps — steady prod)
  // ---------------------------------------------------------------

  // State at a past boundary = address_state NOW minus the deltas that
  // landed after the boundary. The adjustment set is bounded by the
  // gap (≤ DIFFERENTIAL_MAX days of activity), each query an
  // idx_abh_height range scan or an IN-list of PK prefixes.
  private async differentialSnapshot(
    bucketTs: number,
    isCurrent: boolean,
  ): Promise<SnapshotRow | null> {
    const boundary = await this.boundaryAtTime(bucketTs);
    if (boundary === null || boundary.height === 0) return null;
    const h = boundary.height;

    const [h24, h30, h180] = await Promise.all([
      this.heightAtOrBefore(bucketTs - DAY),
      this.heightAtOrBefore(bucketTs - 30 * DAY),
      this.heightAtOrBefore(bucketTs - 180 * DAY),
    ]);

    let balances: number[];
    let hodler30d = 0;
    let hodler180d = 0;

    if (isCurrent) {
      // Live shortcut: magnitude distribution from the live positives.
      balances = await positiveBalancesDesc();
      ({ hodler30d, hodler180d } = await this.liveHodlerCounts(h, h30, h180));
    } else {
      const reconstructed = await this.reconstructAt(h);
      balances = [];
      for (const t of reconstructed.values()) {
        if (t.balance <= 0n) continue;
        balances.push(Number(t.balance));
        if (h30 !== null && t.lastSeen <= h30) hodler30d += 1;
        if (h180 !== null && t.lastSeen <= h180) hodler180d += 1;
      }
      balances.sort((a, b) => b - a);
    }

    const [active24h, new24h] = await Promise.all([
      h24 === null ? Promise.resolve(0) : this.windowActiveCount(h24, h),
      h24 === null ? Promise.resolve(0) : this.windowNewCount(h24, h),
    ]);

    return {
      bucketTs,
      totalSupply: boundary.supply.toString(),
      addressesWithBalance: balances.length,
      ...distributionStats(balances),
      active24h,
      new24h,
      hodler30d,
      hodler180d,
    };
  }

  // Boundary height for a bucket: last block at-or-before its 00:00
  // (matches dayBoundaries' semantics), plus the supply at that block,
  // walking back past NULL money_supply values.
  private async boundaryAtTime(ts: number): Promise<{ height: number; supply: bigint } | null> {
    const h = await this.heightAtOrBefore(ts);
    if (h === null || h === 0) return null;
    const supplyRows = await query<{ s: string | null }>(
      `
        SELECT CAST(money_supply AS CHAR) AS s
        FROM blocks
        WHERE height <= $h AND money_supply IS NOT NULL
        ORDER BY height DESC
        LIMIT 1
      `,
      { h },
    );
    return { height: h, supply: BigInt(supplyRows[0]?.s ?? '0') };
  }

  // max(height) over an open-ended `time <=` range scans the whole
  // time index (~0.7s warm on 4M blocks, seconds cold on HDD prod).
  // Restricting to the trailing day keeps it a ~1k-row range scan and
  // stays exact (block-time drift is minutes, nowhere near a day);
  // an empty window (chain gap / pre-genesis) falls back to the full
  // form.
  private async heightAtOrBefore(ts: number): Promise<number | null> {
    const windowed = await query<{ h: number | null }>(
      `SELECT max(height) AS h FROM blocks
       WHERE time <= FROM_UNIXTIME($at) AND time > FROM_UNIXTIME($lo)`,
      { at: ts, lo: ts - DAY },
    );
    let h = windowed[0]?.h;
    if (h === null || h === undefined) {
      const full = await query<{ h: number | null }>(
        'SELECT max(height) AS h FROM blocks WHERE time <= FROM_UNIXTIME($at)',
        { at: ts },
      );
      h = full[0]?.h;
    }
    return h === null || h === undefined || Number(h) === 0 ? null : Number(h);
  }

  // Balances + last_seen as of height h, reconstructed backwards from
  // the live projection: subtract every delta that landed after h, and
  // re-resolve last_seen for exactly the adjusted addresses.
  private async reconstructAt(h: number): Promise<Map<string, { balance: bigint; lastSeen: number }>> {
    const out = new Map<string, { balance: bigint; lastSeen: number }>();

    const live = await query<{
      address: string; balance: string;
      last_seen_block: number | null; first_seen_block: number | null;
    }>(
      `
        SELECT address, CAST(balance AS CHAR) AS balance,
               last_seen_block, first_seen_block
        FROM address_state
        WHERE balance > 0
      `,
    );
    for (const r of live) {
      if (r.first_seen_block !== null && Number(r.first_seen_block) > h) continue;
      out.set(r.address, {
        balance: BigInt(r.balance),
        lastSeen: r.last_seen_block === null ? 0 : Number(r.last_seen_block),
      });
    }

    const adjustments = await query<{ address: string; d: string }>(
      `
        SELECT address, CAST(SUM(delta) AS CHAR) AS d
        FROM address_balance_history
        WHERE valid_from_height > $h AND address != ''
        GROUP BY address
      `,
      { h },
    );
    // Addresses adjusted but not in the live-positive set (zero or
    // negative NOW, possibly positive at h) need their live balance
    // resurrected — one batched lookup, then subtract like the rest.
    const adjusted: string[] = [];
    const misses: string[] = [];
    for (const r of adjustments) {
      adjusted.push(r.address);
      if (!out.has(r.address)) misses.push(r.address);
    }
    const missBal = new Map<string, bigint>();
    if (misses.length > 0) {
      const rows = await query<{ address: string; balance: string }>(
        'SELECT address, CAST(balance AS CHAR) AS balance FROM address_state WHERE address IN ($addrs)',
        { addrs: misses },
      );
      for (const r of rows) missBal.set(r.address, BigInt(r.balance));
    }
    for (const r of adjustments) {
      const adj = BigInt(r.d);
      const cur = out.get(r.address);
      if (cur) {
        cur.balance -= adj;
      } else {
        // If every delta the address has is post-h, the subtraction
        // lands on 0 and the cleanup below drops it.
        out.set(r.address, { balance: (missBal.get(r.address) ?? 0n) - adj, lastSeen: 0 });
      }
    }
    for (const [a, t] of out) {
      if (t.balance <= 0n) out.delete(a);
    }

    // last_seen at h for the adjusted survivors (their live last_seen
    // is post-h by construction).
    if (adjusted.length > 0) {
      const corrections = await query<{ address: string; ls: number | string | null }>(
        `
          SELECT address, MAX(valid_from_height) AS ls
          FROM address_balance_history
          WHERE address IN ($addrs) AND valid_from_height <= $h
          GROUP BY address
        `,
        { addrs: adjusted, h },
      );
      const lsAt = new Map<string, number>();
      for (const r of corrections) {
        if (r.ls !== null) lsAt.set(r.address, Number(r.ls));
      }
      for (const a of adjusted) {
        const t = out.get(a);
        if (!t) continue;
        const ls = lsAt.get(a);
        if (ls === undefined) out.delete(a); // no pre-h history at all
        else t.lastSeen = ls;
      }
    }
    return out;
  }

  // Hodler counts for the CURRENT bucket, from the live projection:
  // positive balance + last activity at-or-before the cutoff height.
  private async liveHodlerCounts(
    h: number,
    h30: number | null,
    h180: number | null,
  ): Promise<{ hodler30d: number; hodler180d: number }> {
    const countAt = async (cutoff: number | null): Promise<number> => {
      if (cutoff === null) return 0;
      const rows = await query<{ c: number | string }>(
        `
          SELECT count(*) AS c FROM address_state
          WHERE balance > 0 AND last_seen_block <= $cut
        `,
        { cut: cutoff },
      );
      return Number(rows[0]?.c ?? 0);
    };
    const [hodler30d, hodler180d] = await Promise.all([countAt(h30), countAt(h180)]);
    return { hodler30d, hodler180d };
  }

  private async windowActiveCount(lo: number, hi: number): Promise<number> {
    const rows = await query<{ c: number | string }>(
      `
        SELECT count(DISTINCT address) AS c
        FROM address_balance_history
        WHERE valid_from_height > $lo AND valid_from_height <= $hi
          AND address != ''
      `,
      { lo, hi },
    );
    return Number(rows[0]?.c ?? 0);
  }

  // Addresses whose FIRST-ever event landed inside the window. An
  // address active in (lo, hi] has first_seen_block ≤ hi by
  // definition, so the join test reduces to first_seen_block > lo.
  private async windowNewCount(lo: number, hi: number): Promise<number> {
    const rows = await query<{ c: number | string }>(
      `
        SELECT count(*) AS c
        FROM (
          SELECT DISTINCT address
          FROM address_balance_history
          WHERE valid_from_height > $lo AND valid_from_height <= $hi
            AND address != ''
        ) AS w
        JOIN address_state s ON s.address = w.address
        WHERE s.first_seen_block > $lo
      `,
      { lo, hi },
    );
    return Number(rows[0]?.c ?? 0);
  }
}
