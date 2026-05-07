import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { getTipAnchor } from '../lib/indexerTip';
import { getCursor } from '../lib/redis';
import { withMeta } from '../lib/responseMeta';
import { parseAt } from '../lib/timeMachine';
import { NetworkStatsPoller, NetworkStatsPayload } from '../services/network/NetworkStatsPoller';

export const networkRouter = Router();

// Network stats are mutable on every poll — the dashboard refreshes
// /network every 30 s and its meaning changes minute-to-minute. `no-store`
// prevents the browser's HTTP cache from re-validating with stale ETags
// (which previously made the dashboard freeze on first paint).
networkRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

interface SnapshotRow {
  ts: number | string;
  peer_count: number;
  mempool_size: number;
  difficulty: string;
  tip_height: number;
}

function tsToUnix(t: number | string): number {
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// Build network-stats `attributes` from whatever we can find. Used as a
// fallback whenever the live cache or a historical snapshot lookup is
// empty — so the headline tiles never paint '—' as long as the indexer
// has touched ClickHouse at all.
//
// Live-observability fields (daemon's tip, peer count, mempool size,
// daemon version) come from the cached poller value rather than the
// historical snapshot — they describe the daemon RIGHT NOW, not the
// chain state at the requested anchor. Without this overlay the
// "Indexed / Tip" tile blanks out during deep backfill, because the
// historical anchor sits years before the snapshot table's earliest row.
async function buildFallbackAttrs(snapshotAtOrBefore?: number): Promise<Record<string, unknown> | null> {
  const snapResult = await ch.query({
    query: snapshotAtOrBefore !== undefined
      ? 'SELECT toUnixTimestamp(ts) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts <= toDateTime({at: UInt32}) ORDER BY ts DESC LIMIT 1'
      : 'SELECT toUnixTimestamp(ts) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots ORDER BY ts DESC LIMIT 1',
    query_params: snapshotAtOrBefore !== undefined ? { at: snapshotAtOrBefore } : {},
    format: 'JSONEachRow',
  });
  const blocksResult = await ch.query({
    query: 'SELECT height, hash, difficulty FROM blocks FINAL ORDER BY height DESC LIMIT 1',
    format: 'JSONEachRow',
  });
  const [snapRows, blockRows, cursor, cachedObserver] = await Promise.all([
    snapResult.json<SnapshotRow>(),
    blocksResult.json<{ height: number; hash: string; difficulty: string }>(),
    getCursor(),
    NetworkStatsPoller.readCache() as Promise<Partial<NetworkStatsPayload> | null>,
  ]);
  const snap = snapRows[0] ?? null;
  const latestBlock = blockRows[0] ?? null;
  if (!snap && !latestBlock && !cursor && !cachedObserver) return null;
  return {
    tip_height: cachedObserver?.tip_height ?? snap?.tip_height ?? null,
    tip_hash: cachedObserver?.tip_hash ?? '',
    indexed_height: cursor?.height ?? null,
    indexer_status: cursor?.status ?? 'backfilling',
    difficulty: latestBlock?.difficulty ?? snap?.difficulty ?? '0',
    peer_count: cachedObserver?.peer_count ?? snap?.peer_count ?? 0,
    mempool_size: cachedObserver?.mempool_size ?? snap?.mempool_size ?? 0,
    net_version: cachedObserver?.net_version ?? 0,
    rpc_version: cachedObserver?.rpc_version ?? 0,
  };
}

networkRouter.get('/', async (req: Request, res: Response) => {
  const at = parseAt(req);

  let anchor = at;
  if (anchor === undefined) {
    const tipAnchor = await getTipAnchor();
    const now = Math.floor(Date.now() / 1000);
    if (tipAnchor !== now) anchor = tipAnchor;
  }

  if (anchor !== undefined) {
    // Daemon version is observer metadata — it describes the wallet
    // we're talking to RIGHT NOW, not the chain state at the requested
    // anchor. Always overlay the cached value so the time-machine
    // historical branch doesn't stomp net_version/rpc_version to 0.
    const cachedObserver = (await NetworkStatsPoller.readCache()) as Partial<NetworkStatsPayload> | null;
    const result = await ch.query({
      query: 'SELECT toUnixTimestamp(ts) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts <= toDateTime({at: UInt32}) ORDER BY ts DESC LIMIT 1',
      query_params: { at: anchor },
      format: 'JSONEachRow',
    });
    const rows = await result.json<SnapshotRow>();
    const snap = rows[0] ?? null;
    // Live-observability fields prefer the cached poller value over the
    // historical snapshot for the same reason as buildFallbackAttrs:
    // tip_height/peer_count/mempool_size are about the daemon as-of-now,
    // not the chain at the anchor. Difficulty stays as-of-anchor since
    // it IS chain state.
    const cursorRow = await getCursor();
    const attrs = snap
      ? {
        tip_height: cachedObserver?.tip_height ?? snap.tip_height,
        tip_hash: cachedObserver?.tip_hash ?? '',
        indexed_height: cursorRow?.height ?? null,
        indexer_status: cursorRow?.status ?? 'backfilling',
        difficulty: snap.difficulty,
        peer_count: cachedObserver?.peer_count ?? snap.peer_count,
        mempool_size: cachedObserver?.mempool_size ?? snap.mempool_size,
        net_version: cachedObserver?.net_version ?? 0,
        rpc_version: cachedObserver?.rpc_version ?? 0,
      }
      : await buildFallbackAttrs(anchor);
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'network_stats',
        id: at !== undefined ? `at:${at}` : `tip:${anchor}`,
        attributes: attrs,
      },
      meta: {
        anchorTs: anchor,
        anchorKind: at !== undefined ? 'at' : 'tip',
        stale: !snap,
      },
    }));
    return;
  }
  const cached = await NetworkStatsPoller.readCache();
  if (cached) {
    res.status(StatusCodes.OK).send(withMeta({
      data: { type: 'network_stats', id: 'now', attributes: cached },
      meta: { anchorKind: 'live' },
    }));
    return;
  }
  const attrs = await buildFallbackAttrs();
  res.status(StatusCodes.OK).send(withMeta({
    data: { type: 'network_stats', id: 'now', attributes: attrs },
    meta: { anchorKind: 'live', stale: true },
  }));
});

networkRouter.get('/history', async (req: Request, res: Response) => {
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '1'), 10) || 1, 1), 168);
  const step = Math.max(0, parseInt(String(req.query.step ?? '0'), 10) || 0);
  const endAtRaw = parseInt(String(req.query.endAt ?? ''), 10);
  const endAt = Number.isFinite(endAtRaw) && endAtRaw > 0
    ? endAtRaw
    : await getTipAnchor();
  const since = endAt - hours * 3600;

  type Point = { ts: number; peerCount: number; mempoolSize: number; difficulty: string; tipHeight: number };

  // Two data sources merged. network_snapshots covers the rolling 7-day
  // window (the only source of peer_count / mempool_size — observational,
  // can't be reconstructed from chain data). blocks covers the full
  // indexed history so the time-machine can scrub years back and still
  // get difficulty + tipHeight sparklines.
  const [snapResult, blockResult] = await Promise.all([
    ch.query({
      query: 'SELECT toUnixTimestamp(ts) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts >= toDateTime({since: UInt32}) AND ts <= toDateTime({end: UInt32}) ORDER BY ts ASC',
      query_params: { since, end: endAt },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: 'SELECT toUnixTimestamp(time) AS time, difficulty, height FROM blocks FINAL WHERE time >= toDateTime({since: UInt32}) AND time <= toDateTime({end: UInt32}) ORDER BY time ASC',
      query_params: { since, end: endAt },
      format: 'JSONEachRow',
    }),
  ]);
  const snapRows = await snapResult.json<SnapshotRow>();
  const blockRows = await blockResult.json<{ time: number; difficulty: string; height: number }>();

  let points: Point[];
  if (snapRows.length > 0) {
    points = snapRows.map((r) => ({
      ts: tsToUnix(r.ts),
      peerCount: r.peer_count,
      mempoolSize: r.mempool_size,
      difficulty: r.difficulty,
      tipHeight: r.tip_height,
    }));
  } else {
    points = blockRows.map((b) => ({
      ts: b.time,
      peerCount: 0,
      mempoolSize: 0,
      difficulty: b.difficulty,
      tipHeight: b.height,
    }));
  }

  if (step > 0 && points.length > 0) {
    const buckets = new Map<number, { sumPeer: number; sumMempool: number; sumTip: number; lastDifficulty: string; n: number }>();
    for (const p of points) {
      const key = Math.floor(p.ts / step) * step;
      const b = buckets.get(key) ?? { sumPeer: 0, sumMempool: 0, sumTip: 0, lastDifficulty: p.difficulty, n: 0 };
      b.sumPeer += p.peerCount;
      b.sumMempool += p.mempoolSize;
      b.sumTip += p.tipHeight;
      b.lastDifficulty = p.difficulty;
      b.n += 1;
      buckets.set(key, b);
    }
    points = Array.from(buckets.entries())
      .map(([ts, b]): Point => ({
        ts,
        peerCount: Math.round(b.sumPeer / b.n),
        mempoolSize: Math.round(b.sumMempool / b.n),
        difficulty: b.lastDifficulty,
        tipHeight: Math.round(b.sumTip / b.n),
      }))
      .sort((a, b) => a.ts - b.ts);
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'network_history',
      id: `last_${hours}h`,
      attributes: { hours, endAt, step, points },
    },
  }));
});

// Per-day difficulty time-series. Backed by the difficulty_daily MV
// (0007_difficulty_aggregates.sql) so the whole-chain query is O(days)
// not O(blocks). `range=year` filters to a single calendar year for the
// per-year small-multiple grid; `range=all` (default) walks the entire
// history. Both shapes return the same row schema so the frontend can
// reuse one renderer.
//
// Difficulty values are emitted as strings — `Decimal(30, 8)` round-trips
// through Number() at the chart layer with float precision (it's a log
// chart; the loss is invisible) but raw JSON.parse'ing them as numbers
// would silently truncate the long tail. Strings stay honest.
networkRouter.get('/difficulty', async (req: Request, res: Response) => {
  const range = String(req.query.range ?? 'all').toLowerCase();
  const yearRaw = parseInt(String(req.query.year ?? ''), 10);
  const isYear = range === 'year';
  if (isYear && (!Number.isInteger(yearRaw) || yearRaw < 2000 || yearRaw > 2999)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [{ status: '400', title: 'Bad Request', detail: 'range=year requires year=YYYY' }],
    });
    return;
  }

  const where = isYear ? 'WHERE bucket_date >= toDate({y0: String}) AND bucket_date < toDate({y1: String})' : '';
  const params = isYear ? { y0: `${yearRaw}-01-01`, y1: `${yearRaw + 1}-01-01` } : {};

  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toDateTime(bucket_date))   AS ts,
        toString(bucket_date)                      AS date,
        toString(minMerge(difficulty_min))         AS dmin,
        toString(maxMerge(difficulty_max))         AS dmax,
        toString(argMinMerge(difficulty_open))     AS dopen,
        toString(argMaxMerge(difficulty_close))    AS dclose,
        sumMerge(difficulty_sum) / countMerge(difficulty_count) AS davg,
        countMerge(difficulty_count)               AS samples
      FROM difficulty_daily
      ${where}
      GROUP BY bucket_date
      ORDER BY bucket_date ASC
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  type Row = {
    ts: number; date: string;
    dmin: string; dmax: string; dopen: string; dclose: string;
    davg: number; samples: number;
  };
  const rows = await result.json<Row>();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'difficulty_history',
      id: isYear ? `year:${yearRaw}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year: isYear ? yearRaw : null,
        points: rows.map((r) => ({
          ts: r.ts,
          date: r.date,
          min: r.dmin,
          max: r.dmax,
          open: r.dopen,
          close: r.dclose,
          avg: r.davg,
          samples: r.samples,
        })),
      },
    },
  }));
});

// Per-day active-staker time-series. Backed by the stakers_daily MV
// (0008_stakers_aggregates.sql) so the whole-chain query is O(days)
// not O(blocks). Mirrors the /difficulty route's shape so the frontend
// can reuse the same range/year contract: `range=year` filters to one
// calendar year for the per-year small-multiple grid; `range=all`
// (default) walks the entire history.
//
// Counts are emitted as numbers — uniq* tops out at ~2^32 and active
// stakers per day stays in the low thousands; native JSON Number is
// safe. `mintTotal` is the per-day sum of `mint` (Halford, UInt64);
// emitted as a string to dodge JSON's 2^53 precision cliff in case
// future supply expansion ever pushes a daily mint past it.
networkRouter.get('/stakers', async (req: Request, res: Response) => {
  const range = String(req.query.range ?? 'all').toLowerCase();
  const yearRaw = parseInt(String(req.query.year ?? ''), 10);
  const isYear = range === 'year';
  if (isYear && (!Number.isInteger(yearRaw) || yearRaw < 2000 || yearRaw > 2999)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [{ status: '400', title: 'Bad Request', detail: 'range=year requires year=YYYY' }],
    });
    return;
  }

  const where = isYear ? 'WHERE bucket_date >= toDate({y0: String}) AND bucket_date < toDate({y1: String})' : '';
  const params = isYear ? { y0: `${yearRaw}-01-01`, y1: `${yearRaw + 1}-01-01` } : {};

  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toDateTime(bucket_date))   AS ts,
        toString(bucket_date)                      AS date,
        uniqIfMerge(researcher_stakers)            AS researchers,
        uniqIfMerge(investor_stakers)              AS investors,
        uniqMerge(total_stakers)                   AS total,
        toString(sumMerge(mint_sum))               AS mintTotal,
        countMerge(pos_blocks)                     AS blocks
      FROM stakers_daily
      ${where}
      GROUP BY bucket_date
      ORDER BY bucket_date ASC
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  // CH ships UInt64 over the JSONEachRow wire as STRINGS to dodge the
  // JS Number precision cliff at 2^53 — `uniqMerge`, `countMerge`, and
  // `sumMerge(UInt64)` all return string. The actual values for counts
  // here (researchers/investors/total/blocks) fit comfortably in a
  // double, so coerce them to JSON numbers before responding so the
  // frontend can do arithmetic on them (`+=`, `>`, `Math.max`) without
  // string-concatenation footguns. `mintTotal` stays a string — daily
  // mint sums are well below 2^53 today, but cumulative-style queries
  // we may layer on top later could blow through it.
  type Row = {
    ts: number; date: string;
    researchers: string; investors: string; total: string;
    mintTotal: string; blocks: string;
  };
  const rows = await result.json<Row>();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'stakers_history',
      id: isYear ? `year:${yearRaw}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year: isYear ? yearRaw : null,
        points: rows.map((r) => ({
          ts: r.ts,
          date: r.date,
          researchers: Number(r.researchers),
          investors: Number(r.investors),
          total: Number(r.total),
          mintTotal: r.mintTotal,
          blocks: Number(r.blocks),
        })),
      },
    },
  }));
});

networkRouter.get('/bounds', async (_req: Request, res: Response) => {
  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(min(time)) AS minTs,
        toUnixTimestamp(max(time)) AS maxTs,
        min(height) AS minHeight,
        max(height) AS maxHeight
      FROM blocks FINAL
    `,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    minTs: number | null; maxTs: number | null;
    minHeight: number | null; maxHeight: number | null;
  }>();
  const r = rows[0] ?? { minTs: null, maxTs: null, minHeight: null, maxHeight: null };
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'time_bounds',
      id: 'now',
      attributes: {
        minTs: r.minTs,
        maxTs: r.maxTs,
        minHeight: r.minHeight,
        maxHeight: r.maxHeight,
      },
    },
  }));
});
