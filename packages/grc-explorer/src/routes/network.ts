import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { getTipAnchor } from '../lib/indexerTip';
import { getCursor } from '../lib/redis';
import { clampedQueryInt, parseYearRange } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { swrCachedLiveKeyed } from '../lib/swrCache';
import { DailyVersionRow, rollupClientVersions } from '../lib/clientVersions';
import { parseAt } from '../lib/timeMachine';
import { NetworkStatsPoller, NetworkStatsPayload } from '../services/network/NetworkStatsPoller';
import { forksActivated, resolveChainForks } from '../services/network/ChainForks';
import { tsToUnix } from '../lib/time';

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

// Build network-stats `attributes` from whatever we can find. Used as a
// fallback whenever the live cache or a historical snapshot lookup is
// empty — so the headline tiles never paint '—' as long as the indexer
// has touched the database at all.
//
// Live-observability fields (daemon's tip, peer count, mempool size,
// daemon version) come from the cached poller value rather than the
// historical snapshot — they describe the daemon RIGHT NOW, not the
// chain state at the requested anchor. Without this overlay the
// "Indexed / Tip" tile blanks out during deep backfill, because the
// historical anchor sits years before the snapshot table's earliest row.
async function buildFallbackAttrs(snapshotAtOrBefore?: number): Promise<Record<string, unknown> | null> {
  const snapPromise = snapshotAtOrBefore !== undefined
    ? query<SnapshotRow>(
      'SELECT CAST(epoch(ts) AS BIGINT) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts <= make_timestamp($at::BIGINT * 1000000) ORDER BY ts DESC LIMIT 1',
      { at: snapshotAtOrBefore },
    )
    : query<SnapshotRow>(
      'SELECT CAST(epoch(ts) AS BIGINT) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots ORDER BY ts DESC LIMIT 1',
    );
  const blocksPromise = query<{ height: number; hash: string; difficulty: string }>(
    'SELECT height, hash, difficulty FROM blocks ORDER BY height DESC LIMIT 1',
  );
  const [snapRows, blockRows, cursor, cachedObserver] = await Promise.all([
    snapPromise,
    blocksPromise,
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
    const rows = await query<SnapshotRow>(
      'SELECT CAST(epoch(ts) AS BIGINT) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts <= make_timestamp($at::BIGINT * 1000000) ORDER BY ts DESC LIMIT 1',
      { at: anchor },
    );
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
        // `forks` reflects the at-anchored indexed height, so a
        // time-machine scrub to a pre-V13 block correctly tells the
        // frontend to hide V13 UI even though the live tip is past.
        attributes: attrs
          ? {
            ...attrs,
            forks: forksActivated(
              typeof attrs.indexed_height === 'number' ? attrs.indexed_height : null,
            ),
          }
          : attrs,
      },
      meta: {
        anchorTs: anchor,
        anchorKind: at !== undefined ? 'at' : 'tip',
        stale: !snap,
      },
    }));
    return;
  }
  const cached = await NetworkStatsPoller.readCache() as Partial<NetworkStatsPayload> | null;
  if (cached) {
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'network_stats',
        id: 'now',
        attributes: {
          ...cached,
          // Fork-activation flags computed from the indexer's tip
          // height. Lets the frontend gate V13/V14 UI panels so they
          // appear automatically the moment the chain crosses the
          // activation height — no manual deploy needed.
          forks: forksActivated(
            typeof cached.indexed_height === 'number' ? cached.indexed_height : null,
          ),
        },
      },
      meta: { anchorKind: 'live' },
    }));
    return;
  }
  const attrs = await buildFallbackAttrs();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'network_stats',
      id: 'now',
      attributes: attrs
        ? {
          ...attrs,
          forks: forksActivated(
            typeof attrs.indexed_height === 'number' ? attrs.indexed_height : null,
          ),
        }
        : attrs,
    },
    meta: { anchorKind: 'live', stale: true },
  }));
});

networkRouter.get('/history', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 1, min: 1, max: 168 });
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
  const [snapRows, blockRows] = await Promise.all([
    query<SnapshotRow>(
      'SELECT CAST(epoch(ts) AS BIGINT) AS ts, peer_count, mempool_size, difficulty, tip_height FROM network_snapshots WHERE ts >= make_timestamp($since::BIGINT * 1000000) AND ts <= make_timestamp($end::BIGINT * 1000000) ORDER BY ts ASC',
      { since, end: endAt },
    ),
    query<{ time: number; difficulty: string; height: number }>(
      'SELECT CAST(epoch(time) AS BIGINT) AS time, difficulty, height FROM blocks WHERE time >= make_timestamp($since::BIGINT * 1000000) AND time <= make_timestamp($end::BIGINT * 1000000) ORDER BY time ASC',
      { since, end: endAt },
    ),
  ]);

  let points: Point[];
  if (snapRows.length > 0) {
    points = snapRows.map((r) => ({
      ts: tsToUnix(r.ts) ?? 0,
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
    type Bucket = {
      sumPeer: number; sumMempool: number; sumTip: number; lastDifficulty: string; n: number;
    };
    const buckets = new Map<number, Bucket>();
    for (const p of points) {
      const key = Math.floor(p.ts / step) * step;
      const b = buckets.get(key) ?? {
        sumPeer: 0, sumMempool: 0, sumTip: 0, lastDifficulty: p.difficulty, n: 0,
      };
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
      attributes: {
        hours, endAt, step, points,
      },
    },
  }));
});

// Per-day difficulty time-series. Backed by the difficulty_daily view
// (0004_rollup_views.sql) which already aggregates one row per
// bucket_date, so the whole-chain query is O(days) not O(blocks).
// `range=year` filters to a single calendar year for the per-year
// small-multiple grid; `range=all` (default) walks the entire history.
// Both shapes return the same row schema so the frontend can reuse one
// renderer.
//
// Difficulty values are emitted as strings — DOUBLE round-trips through
// Number() at the chart layer with float precision (it's a log chart;
// the loss is invisible) but raw JSON.parse'ing them as numbers would
// silently truncate the long tail. Strings stay honest.
networkRouter.get('/difficulty', async (req: Request, res: Response) => {
  const yr = parseYearRange(req, res);
  if (!yr) return;
  const { isYear, year } = yr;

  const where = isYear ? 'WHERE bucket_date >= CAST($y0 AS DATE) AND bucket_date < CAST($y1 AS DATE)' : '';
  const params = isYear ? { y0: `${year}-01-01`, y1: `${(year ?? 0) + 1}-01-01` } : {};

  const rows = await query<Row>(
    `
      SELECT
        CAST(epoch(CAST(bucket_date AS TIMESTAMP)) AS BIGINT) AS ts,
        CAST(bucket_date AS VARCHAR)                          AS date,
        CAST(difficulty_min AS VARCHAR)                       AS dmin,
        CAST(difficulty_max AS VARCHAR)                       AS dmax,
        CAST(difficulty_open AS VARCHAR)                      AS dopen,
        CAST(difficulty_close AS VARCHAR)                     AS dclose,
        difficulty_avg                                        AS davg,
        difficulty_count                                      AS samples
      FROM difficulty_daily
      ${where}
      ORDER BY bucket_date ASC
    `,
    params,
  );
  type Row = {
    ts: number; date: string;
    dmin: string; dmax: string; dopen: string; dclose: string;
    davg: number; samples: number;
  };
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'difficulty_history',
      id: isYear ? `year:${year}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year,
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

// On-chain protocol-registry events grouped by key. Mirrors what the
// wallet's `ProtocolRegistry::TryLastBeforeTimestamp` would surface,
// but with the full history chain — the live "current value" per key
// is just the most recent ACTIVE row. Each row of the response is
// one ADD or DELETE event from chain history.
//
// Used by /protocol/registry on the frontend; also the data source
// for the poll aggregator's V13+ magnitude-weight-factor lookup
// (different code path — direct CH ASOF-join in PollWeightAggregator).
networkRouter.get('/protocol-entries', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=60');
  type Row = {
    key: string; value: string; status: string; contract_version: number;
    tx_id: string; previous_hash: string; block_height: number; time: number;
  };
  const rows = await query<Row>(
    `
      SELECT key, value, status,
             contract_version,
             tx_id,
             previous_hash,
             block_height,
             CAST(epoch(time) AS BIGINT) AS time
      FROM protocol_entries
      ORDER BY key ASC, time DESC, tx_id ASC
    `,
  );

  // Group by key. Each group is a chain-ordered list (newest first
  // since we ORDER BY time DESC). The "current" value for a key is
  // the most-recent ACTIVE row; we annotate it so the frontend can
  // surface it without re-scanning the events list.
  const byKey = new Map<string, { key: string; current: Row | null; events: Row[] }>();
  for (const r of rows) {
    let bucket = byKey.get(r.key);
    if (!bucket) {
      bucket = { key: r.key, current: null, events: [] };
      byKey.set(r.key, bucket);
    }
    bucket.events.push(r);
    if (bucket.current === null && r.status === 'ACTIVE') {
      bucket.current = r;
    }
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'protocol_entries',
      id: 'all',
      attributes: {
        keys: Array.from(byKey.values()).map((bucket) => ({
          key: bucket.key,
          current_value: bucket.current?.value ?? null,
          current_set_at_height: bucket.current?.block_height ?? null,
          current_set_at_time: bucket.current?.time ?? null,
          events: bucket.events.map((e) => ({
            value: e.value,
            status: e.status,
            block_height: e.block_height,
            time: e.time,
            tx_id: e.tx_id,
            previous_hash: e.previous_hash,
            contract_version: e.contract_version,
          })),
        })),
      },
    },
  }));
});

// Canonical consensus-fork table with each fork's activation height
// and block-time on the active network. Powers (a) the /protocol
// reference page (full table + summaries), and (b) the difficulty
// chart's vertical marker annotations. Cached for a minute since
// once the indexer has crossed a fork the answer is monotonic.
networkRouter.get('/forks', async (_req: Request, res: Response) => {
  const forks = await resolveChainForks();
  // Fork activation timestamps are monotonic — once a fork is crossed,
  // its block-time never changes. A long TTL is safe; SWR keeps the
  // user-perceived response fast through the day.
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'chain_forks',
      id: 'all',
      attributes: {
        forks: forks.map((f) => ({
          key: f.key,
          height: f.height,
          timestamp: f.timestamp,
          chart_label: f.chartLabel,
          summary: f.summary,
          category: f.category,
        })),
      },
    },
  }));
});

// Per-day active-staker time-series. Backed by the stakers_daily view
// (0004_rollup_views.sql) which already aggregates one row per
// bucket_date, so the whole-chain query is O(days) not O(blocks).
// Mirrors the /difficulty route's shape so the frontend can reuse the
// same range/year contract: `range=year` filters to one calendar year
// for the per-year small-multiple grid; `range=all` (default) walks the
// entire history.
//
// Counts are emitted as numbers — daily active stakers stays in the low
// thousands; native JSON Number is safe. `mintTotal` is the per-day sum
// of `mint` (Halford, UBIGINT); emitted as a string to dodge JSON's
// 2^53 precision cliff in case future supply expansion ever pushes a
// daily mint past it.
networkRouter.get('/stakers', async (req: Request, res: Response) => {
  const yr = parseYearRange(req, res);
  if (!yr) return;
  const { isYear, year } = yr;

  const where = isYear ? 'WHERE bucket_date >= CAST($y0 AS DATE) AND bucket_date < CAST($y1 AS DATE)' : '';
  const params = isYear ? { y0: `${year}-01-01`, y1: `${(year ?? 0) + 1}-01-01` } : {};

  // The stakers_daily view already returns plain per-bucket counts,
  // so read the columns directly. `mint_sum` is a UBIGINT and comes
  // back as a string; the count columns fit comfortably in a double,
  // so coerce them to JSON numbers in the mapper below so the frontend
  // can do arithmetic on them (`+=`, `>`, `Math.max`) without
  // string-concatenation footguns. `mintTotal` stays a string — daily
  // mint sums are well below 2^53 today, but cumulative-style queries
  // we may layer on top later could blow through it.
  type Row = {
    ts: number; date: string;
    researchers: string; investors: string; total: string;
    mintTotal: string; blocks: string;
  };
  const rows = await query<Row>(
    `
      SELECT
        CAST(epoch(CAST(bucket_date AS TIMESTAMP)) AS BIGINT) AS ts,
        CAST(bucket_date AS VARCHAR)                          AS date,
        researcher_stakers                                    AS researchers,
        investor_stakers                                      AS investors,
        total_stakers                                         AS total,
        CAST(mint_sum AS VARCHAR)                             AS mintTotal,
        pos_blocks                                            AS blocks
      FROM stakers_daily
      ${where}
      ORDER BY bucket_date ASC
    `,
    params,
  );
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'stakers_history',
      id: isYear ? `year:${year}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year,
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
  const rows = await query<{
    minTs: number | null; maxTs: number | null;
    minHeight: number | null; maxHeight: number | null;
  }>(
    `
      SELECT
        CAST(epoch(min(time)) AS BIGINT) AS minTs,
        CAST(epoch(max(time)) AS BIGINT) AS maxTs,
        min(height) AS minHeight,
        max(height) AS maxHeight
      FROM blocks
    `,
  );
  const r = rows[0] ?? {
    minTs: null, maxTs: null, minHeight: null, maxHeight: null,
  };
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

// Per-day staking-client version mix, backed by the client_versions_daily
// view (0007). `range=year` filters to one calendar year; `range=all`
// (default) walks the whole post-Fern history. Same range/year contract
// as /stakers. swr-cached per range: the GROUP BY is cheap (~tens of ms)
// but ROLE=all shares one DuckDB connection with the indexer's writes, so
// collapsing repeat page-loads into one query per window keeps reads off
// the write path. Bypassed automatically while backfilling.
const CLIENT_VERSIONS_TTL_MS = 300_000;
type JsonApiResource = { type: string; id: string; attributes: Record<string, unknown> };
const getClientVersions = swrCachedLiveKeyed<JsonApiResource>(CLIENT_VERSIONS_TTL_MS);

async function buildClientVersions(isYear: boolean, year: number | null): Promise<JsonApiResource> {
  const where = isYear
    ? 'WHERE bucket_date >= CAST($y0 AS DATE) AND bucket_date < CAST($y1 AS DATE)'
    : '';
  const params = isYear ? { y0: `${year}-01-01`, y1: `${(year ?? 0) + 1}-01-01` } : {};

  // `blocks` is count(*) (UBIGINT) and `ts` is a BIGINT — both come back
  // as strings, so coerce to numbers before the rollup does arithmetic.
  type Row = { ts: string; date: string; raw_version: string; blocks: string };
  const rows = await query<Row>(
    `
      SELECT
        CAST(epoch(CAST(bucket_date AS TIMESTAMP)) AS BIGINT) AS ts,
        CAST(bucket_date AS VARCHAR)                          AS date,
        raw_version,
        blocks
      FROM client_versions_daily
      ${where}
      ORDER BY bucket_date ASC
    `,
    params,
  );

  const mapped: DailyVersionRow[] = rows.map((r) => ({
    ts: Number(r.ts),
    date: r.date,
    raw_version: r.raw_version,
    blocks: Number(r.blocks),
  }));
  const { versions, points } = rollupClientVersions(mapped);

  return {
    type: 'client_versions_history',
    id: isYear ? `year:${year}` : 'all',
    attributes: {
      range: isYear ? 'year' : 'all',
      year,
      versions,
      points,
    },
  };
}

networkRouter.get('/client-versions', async (req: Request, res: Response) => {
  const yr = parseYearRange(req, res);
  if (!yr) return;
  const { isYear, year } = yr;
  const data = await getClientVersions(
    isYear ? `year:${year}` : 'all',
    () => buildClientVersions(isYear, year),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});
