import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
// This module is nothing but cached analytical aggregates: every query
// here runs inside an swrCached* builder (or the active-stakers cache
// below), so a DB read only happens on a cold/expired rebuild, never on a
// cache hit. Route those rebuilds through the MAINTENANCE reader pool so a
// 6-60s metrics recompute can't seize one of the few API request
// connections and stall the fast pages. Warm hits serve from cache and
// touch no pool at all.
import { maintenanceQuery as query } from '../lib/db';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getTipAnchor } from '../lib/indexerTip';
import { clampedQueryInt, parseYearRange } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import {
  swrCached, swrCachedKeyed, swrCachedLive, swrCachedLiveKeyed,
} from '../lib/swrCache';
import { parseAt, resolveAtSuperblockHeight } from '../lib/timeMachine';

export const metricsRouter = Router();

// The legacy `metric_buckets` table is gone — its rollups are now
// served by the network_5m / network_1h / network_1d MVs (block_count,
// tx_count, mint_total, bytes_total). The richer fields the old table
// carried (research_subsidy_total, active_addresses, new_beacons,
// researcher_blocks, investor_blocks) are computed on demand by joining
// blocks + claims + beacons. CH handles these direct aggregations fast
// thanks to columnar scans and partition pruning by time.

interface BucketRow {
  bucket_ts: number;
  block_count: number;
  tx_count: number;
  mint_total: string;
  bytes_total: number;
}

const GRANULARITY_TO_TABLE: Record<string, { table: string; bucketSec: number }> = {
  '5min': { table: 'network_5m', bucketSec: 300 },
  '1h': { table: 'network_1h', bucketSec: 3600 },
  '1d': { table: 'network_1d', bucketSec: 86400 },
};

// Home dashboard's heaviest endpoint. Buckets the last `hours` of
// activity; every bucket but the newest is immutable once it closes
// and the frontend already SSE-debounces 5 min, so a short live-only
// memo collapses the SSR fan-out without visible staleness. Bypassed
// automatically while backfilling.
interface MetricBucket { type: string; id: string; attributes: Record<string, unknown>; }
// Shared shape for the live-gated payload caches below.
type JsonApiResource = { type: string; id: string; attributes: Record<string, unknown> };
const METRICS_TTL_MS = 60_000;
const getMetricBuckets = swrCachedLiveKeyed<MetricBucket[]>(METRICS_TTL_MS);

async function buildMetricBuckets(
  granularityKey: '5min' | '1h',
  table: string,
  bucketSec: number,
  hours: number,
  at: number | undefined,
): Promise<MetricBucket[]> {
  const anchor = at ?? await getTipAnchor();
  // Snap right edge to the latest non-empty bucket at-or-before anchor.
  const latestRows = await query<{ bt: number | null }>(
    `SELECT max(bucket_ts) AS bt FROM ${table} WHERE bucket_ts <= $at`,
    { at: anchor },
  );
  const rightEdge = latestRows[0]?.bt ?? anchor;
  const since = rightEdge - hours * 3600;

  type DerivedRow = {
    bucket_ts: number; research_subsidy_total: string; block_subsidy_total: string;
    researcher_blocks: number; investor_blocks: number;
  };
  type TxBucketRow = { bucket_ts: number; value_moved: string; fee_total: string };

  // Base metrics come from the rollup view (already one row per bucket).
  // Derived metrics (research, staker mix) bin the source tables on the
  // same boundary the view uses. bucket_ts is cast UINTEGER so it
  // deserialises as a JS number to match the view's bucket key.
  const [buckets, derivedRows, txRows] = await Promise.all([
    query<BucketRow>(
      `
        SELECT
          bucket_ts,
          CAST(block_count AS UNSIGNED) AS block_count,
          CAST(tx_count AS UNSIGNED)    AS tx_count,
          CAST(mint_total AS CHAR)      AS mint_total,
          CAST(bytes_total AS UNSIGNED) AS bytes_total
        FROM ${table}
        WHERE bucket_ts >= $since AND bucket_ts <= $end
        ORDER BY bucket_ts ASC
      `,
      { since, end: rightEdge },
    ),
    query<DerivedRow>(
      `
        SELECT
          CAST((UNIX_TIMESTAMP(b.time) DIV $step) * $step AS UNSIGNED)             AS bucket_ts,
          CAST(coalesce(sum(c.research_subsidy), 0) AS CHAR)                       AS research_subsidy_total,
          CAST(coalesce(sum(c.block_subsidy), 0) AS CHAR)                          AS block_subsidy_total,
          CAST(SUM(CASE WHEN b.staker_cpid IS NOT NULL AND b.staker_cpid != '' THEN 1 ELSE 0 END) AS UNSIGNED) AS researcher_blocks,
          CAST(SUM(CASE WHEN b.staker_cpid IS NULL OR b.staker_cpid = '' THEN 1 ELSE 0 END) AS UNSIGNED)       AS investor_blocks
        FROM blocks AS b
        LEFT JOIN claims AS c ON c.block_height = b.height
        WHERE b.time >= FROM_UNIXTIME($since)
          AND b.time <= FROM_UNIXTIME($end)
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      { since, end: rightEdge, step: bucketSec },
    ),
    query<TxBucketRow>(
      // Excludes coinbase/coinstake (reward-emitting txs already counted
      // via claims — including total_out would double-count subsidies).
      `
        SELECT
          CAST((UNIX_TIMESTAMP(time) DIV $step) * $step AS UNSIGNED) AS bucket_ts,
          CAST(coalesce(sum(total_out), 0) AS CHAR) AS value_moved,
          CAST(coalesce(sum(fee), 0) AS CHAR)       AS fee_total
        FROM transactions
        WHERE NOT is_coinbase AND NOT is_coinstake
          AND time >= FROM_UNIXTIME($since)
          AND time <= FROM_UNIXTIME($end)
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      { since, end: rightEdge, step: bucketSec },
    ),
  ]);

  const derivedByTs = new Map<number, DerivedRow>();
  for (const d of derivedRows) derivedByTs.set(d.bucket_ts, d);
  const txByTs = new Map<number, TxBucketRow>();
  for (const t of txRows) txByTs.set(t.bucket_ts, t);

  return buckets.map((r) => {
    const d = derivedByTs.get(r.bucket_ts);
    const t = txByTs.get(r.bucket_ts);
    return {
      type: 'metric_bucket',
      id: `${granularityKey}:${r.bucket_ts}`,
      attributes: {
        granularity: granularityKey,
        bucketTs: r.bucket_ts,
        txCount: r.tx_count,
        valueMoved: halford2grc(BigInt(t?.value_moved ?? '0')),
        feeTotal: halford2grc(BigInt(t?.fee_total ?? '0')),
        blockCount: r.block_count,
        researchSubsidyTotal: halford2grc(BigInt(d?.research_subsidy_total ?? '0')),
        blockSubsidyTotal: halford2grc(BigInt(d?.block_subsidy_total ?? '0')),
        activeAddresses: 0,
        newBeacons: 0,
        researcherBlocks: d?.researcher_blocks ?? 0,
        investorBlocks: d?.investor_blocks ?? 0,
      },
    };
  });
}

metricsRouter.get('/', async (req: Request, res: Response) => {
  const granularityKey = (req.query.granularity === '1h' ? '1h' : '5min');
  const { table, bucketSec } = GRANULARITY_TO_TABLE[granularityKey];
  const hours = clampedQueryInt(req, 'hours', { def: 12, min: 1, max: 168 });
  const at = parseAt(req);
  const data = await getMetricBuckets(
    `${granularityKey}:${hours}:${at ?? 'tip'}`,
    () => buildMetricBuckets(granularityKey, table, bucketSec, hours, at),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

// Superblock-cadence (~daily) leaderboard; safe to memo for minutes.
const MAG_LEADERBOARD_TTL_MS = 300_000;
const getMagLeaderboard = swrCachedLiveKeyed<JsonApiResource[]>(MAG_LEADERBOARD_TTL_MS);

async function buildMagLeaderboard(
  limit: number,
  at: number | undefined,
): Promise<JsonApiResource[]> {
  const latestHeight = await resolveAtSuperblockHeight(at);
  if (latestHeight === null) return [];

  // Rolling 14-superblock window so a CPID dropping out of one
  // superblock doesn't dominate the row count.
  const WINDOW = 14;
  const sbHeights = (await query<{ height: number }>(
    `
      SELECT height FROM superblocks
      WHERE height <= $h
      ORDER BY height DESC LIMIT ${WINDOW}
    `,
    { h: latestHeight },
  )).map((r) => r.height);
  if (sbHeights.length === 0) return [];
  const windowMin = sbHeights[sbHeights.length - 1];

  const windowRows = await query<{ cpid: string; superblock_height: number; magnitude: number }>(
    `
      SELECT cpid, superblock_height, magnitude
      FROM superblock_magnitudes
      WHERE superblock_height >= $min AND superblock_height <= $max
      ORDER BY superblock_height DESC
    `,
    { min: windowMin, max: latestHeight },
  );

  const latestByCpid = new Map<string, number>();
  const histByCpid = new Map<string, Array<{ height: number; magnitude: number }>>();
  for (const r of windowRows) {
    if (!latestByCpid.has(r.cpid)) latestByCpid.set(r.cpid, r.magnitude);
    const arr = histByCpid.get(r.cpid) ?? [];
    arr.push({ height: r.superblock_height, magnitude: r.magnitude });
    histByCpid.set(r.cpid, arr);
  }
  const top = [...latestByCpid.entries()]
    .map(([cpid, magnitude]) => ({ cpid, magnitude }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, limit);

  // Server-side name resolution so the SSR seed needs no second
  // /cpids/names round trip.
  const names = await resolveCpidNames(top.map((t) => t.cpid));

  return top.map((t) => ({
    type: 'magnitude_leaderboard',
    id: t.cpid,
    attributes: {
      cpid: t.cpid,
      displayName: cpidDisplayName(names, t.cpid),
      magnitude: t.magnitude,
      history: histByCpid.get(t.cpid) ?? [],
    },
  }));
}

metricsRouter.get('/leaderboard/magnitude', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const at = parseAt(req);
  const data = await getMagLeaderboard(
    `${limit}:${at ?? 'tip'}`,
    () => buildMagLeaderboard(limit, at),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

// /researchers/history — per-superblock rollup of the magnitude
// leaderboard's shape over the whole chain. Powers the
// /researchers/history page: a whole-chain headline chart (active
// researcher count + top-10 share) and a year-tile grid.
//
// Per-year drill-down lines are served separately by
// /researchers/history/year/:year/series so the chain-wide payload
// stays small for the homepage SSR.
//
// "Active" = magnitude > 0 in the superblock manifest. Matches the
// definition the leaderboard endpoints already use; total_magnitude
// in the superblocks table includes zero-magnitude entries so we
// recompute from superblock_magnitudes for consistency.
//
// Cached 1h: the underlying data only changes on superblock landings
// (~daily). The cache is also invalidated implicitly by process
// restart, so a deploy resets it.

interface ResearchersHistoryPoint {
  height: number;
  ts: number;
  date: string;
  active: number;
  totalMagnitude: number;
  top10Magnitude: number;
  top10Share: number;
}

const RESEARCHERS_HISTORY_TTL_MS = 60 * 60 * 1000;

interface ResearchersHistoryRow {
  height: number;
  // epoch(...)::BIGINT and count(*) come off the DuckDB wire as decimal
  // *strings* (64-bit ints aren't JS-safe), so the types stay honest and
  // the row mapper coerces with Number().
  time: number | string;
  active: number | string;
  total_magnitude: number;
  top10_magnitude: number;
}

async function buildResearchersHistory(): Promise<ResearchersHistoryPoint[]> {
  // Reads the superblock_researcher_stats rollup (maintained by
  // RollupMaintainer, seeded in migration 0008) — ~3k rows joined to
  // blocks by PK. The previous inline aggregation windowed over ALL of
  // superblock_magnitudes (3.6M rows) per cold rebuild, which evicted
  // most of a small buffer pool every TTL.
  //
  // INNER JOIN on the blocks PK: a superblock only appears once its
  // block row is committed. During backfill the stats row for the
  // newest superblock can land just before the block row (blocks are
  // written last), so a LEFT JOIN would emit a NULL time — which
  // became epoch 0 / 1970-01-01 and dragged the chart's x-axis origin
  // back to 1970. INNER JOIN drops that transient row instead.
  const rows = await query<ResearchersHistoryRow>(
    `
      SELECT
        m.superblock_height AS height,
        UNIX_TIMESTAMP(b.time) AS time,
        m.active AS active,
        m.total_magnitude AS total_magnitude,
        m.top10_magnitude AS top10_magnitude
      FROM superblock_researcher_stats AS m
      JOIN blocks AS b ON b.height = m.superblock_height
      ORDER BY m.superblock_height ASC
    `,
  );
  return rows.map((r) => {
    // epoch(...)::BIGINT comes off the wire as a decimal string; coerce so
    // ts is a real number (the chart x-axis and Date math depend on it).
    const ts = Number(r.time);
    return {
      height: r.height,
      ts,
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      active: Number(r.active),
      totalMagnitude: r.total_magnitude,
      top10Magnitude: r.top10_magnitude,
      top10Share: r.total_magnitude > 0 ? r.top10_magnitude / r.total_magnitude : 0,
    };
  });
}

const getResearchersHistory = swrCached(buildResearchersHistory, RESEARCHERS_HISTORY_TTL_MS);

// Top-N series within a height range: for each of the top-N CPIDs
// (ranked by total magnitude across all superblocks in the range),
// return their per-superblock magnitude. Powers the multi-line
// charts on /researchers/history — one line per CPID, hover
// identifies who. Used for both the year drill-down (bounded by
// year start/end) and the whole-chain view (bounded by genesis/tip).
//
// "Top by total magnitude in the range" weights both height (peak
// magnitude) and persistence (number of superblocks present), which
// surfaces the researchers who *mattered* in that window — not just
// whoever flashed briefly into #1 on a single superblock.

interface SeriesRow {
  cpid: string;
  height: number;
  magnitude: number;
}

interface SeriesEntry {
  cpid: string;
  displayName: string | null;
  points: Array<{ height: number; magnitude: number }>;
}

const SERIES_TTL_MS = 60 * 60 * 1000;
const getCachedSeries = swrCachedKeyed<SeriesEntry[]>(SERIES_TTL_MS);

function downsampleSeriesPoints(
  points: Array<{ height: number; magnitude: number }>,
  maxPoints: number | null,
): Array<{ height: number; magnitude: number }> {
  if (maxPoints === null || points.length <= maxPoints) return points;
  if (maxPoints <= 1) return [points[points.length - 1]];
  const sampled: Array<{ height: number; magnitude: number }> = [];
  const last = points.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(points[Math.round((i * last) / (maxPoints - 1))]);
  }
  return sampled;
}

async function buildSeries(
  minH: number,
  maxH: number,
  limit: number,
  maxPoints: number | null,
): Promise<SeriesEntry[]> {
  // Two-step query — pick the top-N CPIDs by total magnitude-days in
  // the height range, then fetch their per-superblock magnitudes.
  // `superblock_magnitudes` only has rows for actual superblock
  // heights, so a height range filter is implicit-superblock without
  // a separate join.
  const rows = await query<SeriesRow>(
    `
      WITH top_cpids AS (
        SELECT cpid
        FROM superblock_magnitudes
        WHERE superblock_height >= $minH
          AND superblock_height <= $maxH
          AND magnitude > 0
        GROUP BY cpid
        ORDER BY sum(magnitude) DESC
        LIMIT ${Number(limit)}
      )
      SELECT cpid, superblock_height AS height, magnitude
      FROM superblock_magnitudes
      WHERE cpid IN (SELECT cpid FROM top_cpids)
        AND superblock_height >= $minH
        AND superblock_height <= $maxH
        AND magnitude > 0
      ORDER BY cpid, superblock_height
    `,
    { minH, maxH },
  );

  const byCpid = new Map<string, Array<{ height: number; magnitude: number }>>();
  for (const r of rows) {
    const arr = byCpid.get(r.cpid) ?? [];
    arr.push({ height: r.height, magnitude: r.magnitude });
    byCpid.set(r.cpid, arr);
  }
  // Sort series by total magnitude-days descending so the frontend
  // can render rank-aware visual cues (palette assignment, label
  // priority on hover collisions).
  const series: Array<{ cpid: string; points: Array<{ height: number; magnitude: number }>; total: number }> = [];
  for (const [cpid, points] of byCpid.entries()) {
    let total = 0;
    for (const p of points) total += p.magnitude;
    series.push({ cpid, points, total });
  }
  series.sort((a, b) => b.total - a.total);
  // Server-side names so /researchers/history renders its per-CPID
  // lines from the SSR seed without a second /cpids/names round trip.
  const names = await resolveCpidNames(series.map((s) => s.cpid));
  return series.map(({ cpid, points }) => ({
    cpid,
    displayName: cpidDisplayName(names, cpid),
    points: downsampleSeriesPoints(points, maxPoints),
  }));
}

async function getYearSeries(year: number, limit: number, maxPoints: number | null): Promise<SeriesEntry[]> {
  return getCachedSeries(`year:${year}:${limit}:${maxPoints ?? 'all'}`, async () => {
    // Bound height range to the year using the cached chain-wide
    // history. Avoids a separate blocks-table round trip and keeps
    // the filter aligned with whatever the chain-wide chart shows.
    const chain = await getResearchersHistory();
    const inYear = chain.filter((p) => p.date.startsWith(`${year}-`));
    if (inYear.length === 0) return [];
    return buildSeries(inYear[0].height, inYear[inYear.length - 1].height, limit, maxPoints);
  });
}

async function getChainSeries(limit: number, maxPoints: number | null): Promise<SeriesEntry[]> {
  return getCachedSeries(`chain:${limit}:${maxPoints ?? 'all'}`, async () => {
    const chain = await getResearchersHistory();
    if (chain.length === 0) return [];
    return buildSeries(chain[0].height, chain[chain.length - 1].height, limit, maxPoints);
  });
}

metricsRouter.get('/researchers/history/year/:year/series', async (req: Request, res: Response) => {
  const year = parseInt(String(req.params.year), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad Request', 'year must be YYYY')],
    });
    return;
  }
  const limit = clampedQueryInt(req, 'limit', { def: 30, min: 1, max: 100 });
  const maxPoints = req.query.maxPoints === undefined
    ? null
    : clampedQueryInt(req, 'maxPoints', { def: 600, min: 2, max: 5000 });
  const series = await getYearSeries(year, limit, maxPoints);
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'researchers_year_series',
      id: `year:${year}:limit:${limit}`,
      attributes: { year, limit, series },
    },
  }));
});

metricsRouter.get('/researchers/history/series', async (req: Request, res: Response) => {
  const limit = clampedQueryInt(req, 'limit', { def: 30, min: 1, max: 100 });
  const maxPoints = req.query.maxPoints === undefined
    ? null
    : clampedQueryInt(req, 'maxPoints', { def: 600, min: 2, max: 5000 });
  const series = await getChainSeries(limit, maxPoints);
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'researchers_chain_series',
      id: `chain:limit:${limit}`,
      attributes: { limit, series },
    },
  }));
});

metricsRouter.get('/researchers/history', async (req: Request, res: Response) => {
  const yr = parseYearRange(req, res);
  if (!yr) return;
  const { isYear, year } = yr;
  const all = await getResearchersHistory();
  const points = isYear ? all.filter((p) => p.date.startsWith(`${year}-`)) : all;
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'researchers_history',
      id: isYear ? `year:${year}` : 'all',
      attributes: {
        range: isYear ? 'year' : 'all',
        year,
        points,
      },
    },
  }));
});

// Aggregate stats for the home-page MSS tile. Three slices in one
// payload so the tile is one round trip:
//   - 24h count + amount (since tip-time minus 24h)
//   - all-time count + amount
//   - active recipient count
// Reads are cheap; coinstake_sidestakes is small even at V13 cadence
// (≤4 outputs per coinstake × ~570 blocks/day = ~2280 rows/day).
// Home-tile aggregate over `coinstake_sidestakes` — small table but
// scanned in full for the all-time totals. Cache 60s so the home-page
// SSR fan-out coalesces. Underlying data only changes on V13+ PoS
// blocks landing (~570/day).
let mssMetricsCache: { body: unknown; expiresAt: number } | null = null;
const MSS_METRICS_TTL_MS = 60_000;
metricsRouter.get('/mandatory-sidestakes', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (mssMetricsCache && now < mssMetricsCache.expiresAt) {
    res.status(StatusCodes.OK).send(mssMetricsCache.body);
    return;
  }
  const at = await getTipAnchor();
  const since24h = at - 24 * 3600;
  const row = (await query<{
    amount_24h: string; count_24h: number;
    amount_all: string; count_all: number;
    active_recipients: number;
  }>(
    `
      WITH active AS (
        -- arg_max(status, block_height) per address → status of the row with
        -- the highest block_height, via ROW_NUMBER()=1.
        SELECT address
        FROM (
          SELECT address, status,
            ROW_NUMBER() OVER (PARTITION BY address ORDER BY block_height DESC) AS rn
          FROM mandatory_sidestakes
        ) latest
        WHERE rn = 1 AND status = 'MANDATORY'
      )
      SELECT
        CAST(coalesce(SUM(CASE WHEN time >= FROM_UNIXTIME($since) THEN amount ELSE 0 END), 0) AS CHAR) AS amount_24h,
        CAST(SUM(CASE WHEN time >= FROM_UNIXTIME($since) THEN 1 ELSE 0 END) AS UNSIGNED)               AS count_24h,
        CAST(coalesce(sum(amount), 0) AS CHAR)                                                         AS amount_all,
        CAST(count(*) AS UNSIGNED)                                                                     AS count_all,
        CAST((SELECT count(*) FROM active) AS UNSIGNED)                                                AS active_recipients
      FROM coinstake_sidestakes
    `,
    { since: since24h },
  ))[0] ?? {
    amount_24h: '0', count_24h: 0, amount_all: '0', count_all: 0, active_recipients: 0,
  };
  const body = withMeta({
    data: {
      type: 'mandatory_sidestakes_metrics',
      id: 'now',
      attributes: {
        amount24h: halford2grc(BigInt(row.amount_24h)),
        count24h: Number(row.count_24h),
        amountAllTime: halford2grc(BigInt(row.amount_all)),
        countAllTime: Number(row.count_all),
        activeRecipients: Number(row.active_recipients),
      },
    },
  });
  mssMetricsCache = { body, expiresAt: now + MSS_METRICS_TTL_MS };
  res.status(StatusCodes.OK).send(body);
});

// Slow-changing: the window is hours/days and the component already
// SSE-debounces 5 min. Cache the built payload per (hours, anchor);
// bypassed automatically while the indexer is backfilling.
interface ResearchSplitPayload {
  type: string; id: string; attributes: Record<string, unknown>;
}
const RESEARCH_SPLIT_TTL_MS = 120_000;
const getResearchSplit = swrCachedLiveKeyed<ResearchSplitPayload>(RESEARCH_SPLIT_TTL_MS);

metricsRouter.get('/research-split', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 24, min: 1, max: 24 * 365 });
  const at = parseAt(req) ?? await getTipAnchor();
  const data = await getResearchSplit(`${hours}:${at}`, async () => {
    const since = at - hours * 3600;
    const row = (await query<{
      research_subsidy: string; block_subsidy: string;
      researcher_blocks: number; investor_blocks: number;
    }>(
      `
        SELECT
          CAST(coalesce(sum(c.research_subsidy), 0) AS CHAR) AS research_subsidy,
          CAST(coalesce(sum(c.block_subsidy), 0) AS CHAR)    AS block_subsidy,
          CAST(SUM(CASE WHEN b.staker_cpid IS NOT NULL AND b.staker_cpid != '' THEN 1 ELSE 0 END) AS UNSIGNED) AS researcher_blocks,
          CAST(SUM(CASE WHEN b.staker_cpid IS NULL OR b.staker_cpid = '' THEN 1 ELSE 0 END) AS UNSIGNED)       AS investor_blocks
        FROM blocks AS b
        LEFT JOIN claims AS c ON c.block_height = b.height
        WHERE b.time >= FROM_UNIXTIME($since) AND b.time <= FROM_UNIXTIME($end)
      `,
      { since, end: at },
    ))[0] ?? {
      research_subsidy: '0', block_subsidy: '0', researcher_blocks: 0, investor_blocks: 0,
    };
    const research = BigInt(row.research_subsidy);
    const block = BigInt(row.block_subsidy);
    const total = research + block;
    return {
      type: 'research_split',
      id: `last_${hours}h`,
      attributes: {
        hours,
        researchSubsidy: halford2grc(research),
        blockSubsidy: halford2grc(block),
        researcherBlocks: row.researcher_blocks,
        investorBlocks: row.investor_blocks,
        researchSharePct: total > 0n ? Number((research * 10000n) / total) / 100 : 0,
      },
    };
  });
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

const BEACON_FLUX_TTL_MS = 300_000;
const getBeaconFlux = swrCachedLiveKeyed<JsonApiResource>(BEACON_FLUX_TTL_MS);

metricsRouter.get('/beacon-flux', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 24, min: 1, max: 168 });
  const evalAt = parseAt(req) ?? await getTipAnchor();
  const data = await getBeaconFlux(`${hours}:${evalAt}`, async () => {
    const since = evalAt - hours * 3600;
    const row = (await query<{ active: number; new_: number; expired_: number }>(
      `
        SELECT
          CAST(SUM(CASE WHEN timestamp <= FROM_UNIXTIME($end) AND expiration > FROM_UNIXTIME($end) AND status != 'revoked' THEN 1 ELSE 0 END) AS UNSIGNED) AS active,
          CAST(SUM(CASE WHEN timestamp >= FROM_UNIXTIME($since) AND timestamp <= FROM_UNIXTIME($end) AND status != 'revoked' THEN 1 ELSE 0 END) AS UNSIGNED) AS new_,
          CAST(SUM(CASE WHEN expiration >= FROM_UNIXTIME($since) AND expiration < FROM_UNIXTIME($end) THEN 1 ELSE 0 END) AS UNSIGNED) AS expired_
        FROM beacons
      `,
      { since, end: evalAt },
    ))[0] ?? { active: 0, new_: 0, expired_: 0 };
    return {
      type: 'beacon_flux',
      id: `last_${hours}h`,
      attributes: {
        hours,
        active: row.active,
        new: row.new_,
        expired: row.expired_,
      },
    };
  });
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

// Daily snapshot job feeds wealth_snapshots; the latest row only
// changes once a day. Long memo, live-gated.
const WEALTH_DIST_TTL_MS = 600_000;
const getWealthDist = swrCachedLiveKeyed<JsonApiResource | null>(WEALTH_DIST_TTL_MS);

metricsRouter.get('/wealth-distribution', async (req: Request, res: Response) => {
  const at = parseAt(req) ?? await getTipAnchor();
  const data = await getWealthDist(String(at), async () => {
    const snap = (await query<{
      bucket_ts: number; total_supply: string; addresses_with_balance: number;
      gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
      active_24h: number; new_24h: number; hodler_30d: number; hodler_180d: number;
    }>(
      `
        SELECT
          UNIX_TIMESTAMP(bucket_ts) AS bucket_ts,
          CAST(total_supply AS CHAR) AS total_supply,
          addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share,
          active_24h, new_24h, hodler_30d, hodler_180d
        FROM wealth_snapshots
        WHERE bucket_ts <= FROM_UNIXTIME($at)
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      { at },
    ))[0] ?? null;
    return snap
      ? {
        type: 'wealth_distribution',
        id: String(snap.bucket_ts),
        attributes: {
          bucketTs: snap.bucket_ts,
          totalSupply: halford2grc(BigInt(snap.total_supply)),
          addressesWithBalance: snap.addresses_with_balance,
          gini: Number(snap.gini),
          top1pctShare: Number(snap.top1pct_share),
          top10pctShare: Number(snap.top10pct_share),
          top100Share: Number(snap.top100_share),
          active24h: snap.active_24h,
          new24h: snap.new_24h,
          hodler30d: snap.hodler_30d,
          hodler180d: snap.hodler_180d,
        },
      }
      : null;
  });
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

const WEALTH_SERIES_TTL_MS = 600_000;
const getWealthSeries = swrCachedLiveKeyed<JsonApiResource>(WEALTH_SERIES_TTL_MS);

metricsRouter.get('/wealth-distribution/series', async (req: Request, res: Response) => {
  const tipAnchor = await getTipAnchor();
  const to = parseInt(String(req.query.to ?? ''), 10);
  const toTs = Number.isFinite(to) && to > 0 ? to : tipAnchor;
  const from = parseInt(String(req.query.from ?? ''), 10);
  const fromTs = Number.isFinite(from) && from > 0 ? from : toTs - 365 * 86_400;

  const data = await getWealthSeries(`${fromTs}-${toTs}`, async () => {
    const rows = await query<{
      bucket_ts: number; total_supply: string; addresses_with_balance: number;
      gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
    }>(
      `
        SELECT
          UNIX_TIMESTAMP(bucket_ts) AS bucket_ts,
          CAST(total_supply AS CHAR) AS total_supply,
          addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share
        FROM wealth_snapshots
        WHERE bucket_ts >= FROM_UNIXTIME($from) AND bucket_ts <= FROM_UNIXTIME($to)
        ORDER BY bucket_ts ASC
      `,
      { from: fromTs, to: toTs },
    );
    return {
      type: 'wealth_distribution_series',
      id: `${fromTs}-${toTs}`,
      attributes: {
        from: fromTs,
        to: toTs,
        points: rows.map((r) => ({
          bucketTs: r.bucket_ts,
          totalSupply: halford2grc(BigInt(r.total_supply)),
          gini: Number(r.gini),
          top1pctShare: Number(r.top1pct_share),
          top10pctShare: Number(r.top10pct_share),
          top100Share: Number(r.top100_share),
          addressesWithBalance: r.addresses_with_balance,
        })),
      },
    };
  });
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

// Reads the fee_quantiles_1h MV (already FINAL-free); cached anyway
// since the home call fans out 4 CH reads. Live-gated, 2 min.
const FEE_PCTL_TTL_MS = 120_000;
const getFeePercentiles = swrCachedLiveKeyed<JsonApiResource>(FEE_PCTL_TTL_MS);

async function buildFeePercentiles(
  granularityKey: string,
  hours: number,
  at: number | undefined,
): Promise<JsonApiResource> {
  const anchor = at ?? await getTipAnchor();

  // Three concurrent reads:
  //   1. Latest non-empty bucket at-or-before the anchor (drives the
  //      24h window's right edge).
  //   2. Absolute-latest non-empty bucket across all time (for the
  //      empty-state hint — tells the user whether the MV is bare or
  //      whether it has data outside the 24h window).
  //   3. Count of non-empty buckets across all time (so the empty-
  //      state can distinguish "MV literally bare" from "data exists
  //      but not in this window").
  const [latestInRangeRows, latestEverRows, totalRows] = await Promise.all([
    query<{ bucket_ts: number }>(
      `
        SELECT bucket_ts FROM fee_quantiles_1h
        WHERE bucket_ts <= $at AND tx_count > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      { at: anchor },
    ),
    query<{ bucket_ts: number; tx_count: string | number }>(
      `
        SELECT bucket_ts, tx_count
        FROM fee_quantiles_1h
        WHERE tx_count > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
    ),
    query<{ c: string | number }>(
      'SELECT count(*) AS c FROM fee_quantiles_1h WHERE tx_count > 0',
    ),
  ]);
  const latestInRange = latestInRangeRows[0];
  const latestEver = latestEverRows[0];
  const totalRow = totalRows[0];

  const rightEdge = latestInRange?.bucket_ts ?? anchor;
  const since = rightEdge - hours * 3600;

  // HAVING tx_count > 0 filters out zero-count buckets. The MV
  // shouldn't generate them in theory (GROUP BY emits only matching
  // rows), but partial states can collapse to 0 in pathological
  // cases (e.g. early transactions inserted before the size lookup
  // fix landed, where all rows had size=0 and got dropped by the
  // WHERE filter — leaving no input but somehow a bucket entry).
  // Filtering at read time keeps the chart honest regardless.
  // The fee_quantiles_1h view exposes p50/p95/p99 + tx_count directly
  // (CH stored t-digest/count states). Truncate the percentiles to an
  // integer string to match the prior toUInt64(...) wire shape.
  const rows = await query<{
    bucket_ts: number; p50: string; p95: string; p99: string; tx_count: string | number;
  }>(
    `
      SELECT
        bucket_ts,
        CAST(CAST(p50 AS SIGNED) AS CHAR) AS p50,
        CAST(CAST(p95 AS SIGNED) AS CHAR) AS p95,
        CAST(CAST(p99 AS SIGNED) AS CHAR) AS p99,
        tx_count
      FROM fee_quantiles_1h
      WHERE bucket_ts >= $since AND bucket_ts <= $end AND tx_count > 0
      ORDER BY bucket_ts ASC
    `,
    { since, end: rightEdge },
  );
  return {
    type: 'fee_percentiles_series',
    id: `${granularityKey}:${hours}h`,
    attributes: {
      granularity: granularityKey,
      hours,
      from: since,
      to: rightEdge,
      anchor,
      // Diagnostic fields — let the frontend tell the user "your
      // window is empty but the MV holds N buckets, latest at <date>"
      // instead of just "no data, we don't know why".
      latestNonEmptyBucket: latestEver
        ? { bucketTs: Number(latestEver.bucket_ts), txCount: Number(latestEver.tx_count) }
        : null,
      totalNonEmptyBuckets: Number(totalRow?.c ?? 0),
      points: rows.map((r) => ({
        bucketTs: Number(r.bucket_ts),
        p50: r.p50,
        p95: r.p95,
        p99: r.p99,
        txCount: Number(r.tx_count),
      })),
    },
  };
}

metricsRouter.get('/fee-percentiles', async (req: Request, res: Response) => {
  // CH MV `fee_quantiles_1h` is hourly only; "5min"/"1d" map to the
  // closest available bucket size for now. For 5min we fall back to
  // 1h since the MV doesn't carry that granularity.
  const granularityKey = (() => {
    const g = String(req.query.granularity ?? '1h');
    return ['5min', '1h', '1d'].includes(g) ? g : '1h';
  })();
  const hours = clampedQueryInt(req, 'hours', { def: 24, min: 1, max: 168 });
  const at = parseAt(req);
  const data = await getFeePercentiles(
    `${granularityKey}:${hours}:${at ?? 'tip'}`,
    () => buildFeePercentiles(granularityKey, hours, at),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

async function buildBeaconSurvival(): Promise<JsonApiResource> {
  const now = await getTipAnchor();
  const since = now - 365 * 86_400;
  // CH-side cohort bucketing by month-start.
  const rows = await query<{
    cohort: string;
    advertised: string | number;
    confirmed: string | number;
    renewed: string | number;
    expired_: string | number;
  }>(
    `
      SELECT
        DATE_FORMAT(timestamp, '%Y-%m')                         AS cohort,
        CAST(count(*) AS UNSIGNED)                               AS advertised,
        CAST(SUM(CASE WHEN status != 'revoked' THEN 1 ELSE 0 END) AS UNSIGNED)              AS confirmed,
        CAST(SUM(CASE WHEN superseded_at_height IS NOT NULL THEN 1 ELSE 0 END) AS UNSIGNED) AS renewed,
        CAST(SUM(CASE WHEN expiration <= FROM_UNIXTIME($now) THEN 1 ELSE 0 END) AS UNSIGNED) AS expired_
      FROM beacons
      WHERE timestamp >= FROM_UNIXTIME($since)
      GROUP BY cohort
      ORDER BY cohort ASC
    `,
    { now, since },
  );
  return {
    type: 'beacon_survival',
    id: 'last_12mo',
    attributes: {
      points: rows.map((r) => ({
        cohort: r.cohort,
        advertised: Number(r.advertised),
        confirmed: Number(r.confirmed),
        renewed: Number(r.renewed),
        expired: Number(r.expired_),
      })),
    },
  };
}

const BEACON_SURVIVAL_TTL_MS = 300_000;
const getBeaconSurvival = swrCachedLive(buildBeaconSurvival, BEACON_SURVIVAL_TTL_MS);

metricsRouter.get('/beacon-survival', async (_req: Request, res: Response) => {
  res.status(StatusCodes.OK).send(withMeta({ data: await getBeaconSurvival() }));
});

// Monthly cohort × horizon — fully historical once the cohort ages
// out; long live-gated memo keyed by (cohort, horizon).
const COHORT_RETENTION_TTL_MS = 600_000;
const getCohortRetention = swrCachedLiveKeyed<JsonApiResource>(COHORT_RETENTION_TTL_MS);

async function buildCohortRetention(
  cohortStr: string,
  year: number,
  month: number,
  horizon: number,
  cohortStart: number,
  cohortEnd: number,
  horizonEnd: number,
): Promise<JsonApiResource> {
  // CPIDs first observed staking in this cohort window.
  const cohortRows = await query<{ cpid: string; first_ts: number }>(
    `
      SELECT staker_cpid AS cpid, UNIX_TIMESTAMP(min(time)) AS first_ts
      FROM blocks
      WHERE staker_cpid IS NOT NULL AND staker_cpid != ''
      GROUP BY staker_cpid
      HAVING min(time) >= FROM_UNIXTIME($start)
         AND min(time) <  FROM_UNIXTIME($end)
    `,
    { start: cohortStart, end: cohortEnd },
  );
  if (cohortRows.length === 0) {
    return {
      type: 'cpid_cohort_retention',
      id: cohortStr,
      attributes: {
        cohort: cohortStr, horizon, cohortSize: 0, points: [],
      },
    };
  }
  const cpids = cohortRows.map((c) => c.cpid);

  // Distinct cpids per month bucket within the horizon. CH's
  // toStartOfMonth bucketing handles variable month length cleanly.
  const monthlyRows = await query<{ bucket_ts: number | string; active: number | string }>(
    `
      SELECT
        UNIX_TIMESTAMP(DATE_FORMAT(time, '%Y-%m-01')) AS bucket_ts,
        CAST(count(DISTINCT staker_cpid) AS UNSIGNED) AS active
      FROM blocks
      WHERE staker_cpid IN ($cpids)
        AND time >= FROM_UNIXTIME($start)
        AND time <  FROM_UNIXTIME($end)
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `,
    { cpids, start: cohortStart, end: horizonEnd },
  );
  // bucket_ts is epoch(...)::BIGINT — DuckDB returns it as a decimal
  // STRING. The lookup key below is a JS number (Date.UTC), and Map keys
  // compare by identity, so without coercing both to numbers every lookup
  // misses and the whole retention curve collapses to 0 (flat/empty chart).
  const seenByBucket = new Map<number, number>();
  for (const r of monthlyRows) seenByBucket.set(Number(r.bucket_ts), Number(r.active));

  const points = Array.from({ length: horizon }, (_, off) => {
    const bucketTs = Math.floor(Date.UTC(year, month - 1 + off, 1) / 1000);
    return { monthOffset: off, bucketTs, active: seenByBucket.get(bucketTs) ?? 0 };
  });

  return {
    type: 'cpid_cohort_retention',
    id: cohortStr,
    attributes: {
      cohort: cohortStr, horizon, cohortSize: cohortRows.length, points,
    },
  };
}

metricsRouter.get('/cpid-cohort-retention', async (req: Request, res: Response) => {
  const cohortStr = String(req.query.cohort ?? '');
  const m = cohortStr.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad Request', 'cohort must be YYYY-MM')],
    });
    return;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const horizon = clampedQueryInt(req, 'horizon', { def: 12, min: 1, max: 36 });
  const cohortStart = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
  const cohortEnd = Math.floor(Date.UTC(year, month, 1) / 1000);
  const horizonEnd = Math.floor(Date.UTC(year, month - 1 + horizon, 1) / 1000);
  const data = await getCohortRetention(
    `${cohortStr}:${horizon}`,
    () => buildCohortRetention(cohortStr, year, month, horizon, cohortStart, cohortEnd, horizonEnd),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

// Distinct staker count over the last `hours` of chain-time, ending
// at `at` (or indexer tip). The headline is the unique-CPID count
// over the whole window; the per-hour points show trend so the
// sparkline can render the network's recent activity rhythm.
//
// Computed against `blocks` directly — chain-derivable, works for any
// historical moment, doesn't depend on whether our daemon happened to
// be observing the P2P network at that time.
// Two count(DISTINCT staker_cpid) scans over the blocks time-window — was
// uncached and ran on every request. Cache it like every other metric here.
const ACTIVE_STAKERS_TTL_MS = 300_000;
const getActiveStakers = swrCachedLiveKeyed<JsonApiResource>(ACTIVE_STAKERS_TTL_MS);

async function buildActiveStakers(hours: number, at: number): Promise<JsonApiResource> {
  const since = at - hours * 3600;
  const [headlineRows, seriesRows] = await Promise.all([
    query<{ c: string | number }>(
      `
        SELECT count(DISTINCT staker_cpid) AS c
        FROM blocks
        WHERE time >= FROM_UNIXTIME($since) AND time <= FROM_UNIXTIME($end)
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
      `,
      { since, end: at },
    ),
    query<{ bucket_ts: number; count: number }>(
      `
        SELECT
          CAST((UNIX_TIMESTAMP(time) DIV 3600) * 3600 AS UNSIGNED) AS bucket_ts,
          CAST(count(DISTINCT staker_cpid) AS UNSIGNED)            AS count
        FROM blocks
        WHERE time >= FROM_UNIXTIME($since) AND time <= FROM_UNIXTIME($end)
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      { since, end: at },
    ),
  ]);
  const current = Number(headlineRows[0]?.c ?? 0);
  const points = seriesRows.map((p) => ({ ts: p.bucket_ts, count: Number(p.count) }));
  return {
    type: 'active_stakers',
    id: `last_${hours}h`,
    attributes: {
      hours, anchor: at, current, points,
    },
  };
}

metricsRouter.get('/active-stakers', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 24, min: 1, max: 168 });
  const at = parseAt(req);
  // Time-travel (?at=) is exact and rare — build fresh. The live view keys
  // on hours only and reuses the first build's result for the TTL; the
  // "active stakers in the last N hours" window drifts negligibly over 5 min.
  const data = at !== undefined
    ? await buildActiveStakers(hours, at)
    : await getActiveStakers(String(hours), async () => buildActiveStakers(hours, await getTipAnchor()));
  res.status(StatusCodes.OK).send(withMeta({ data }));
});

const STAKER_MIX_TTL_MS = 300_000;
const getStakerMix = swrCachedLiveKeyed<JsonApiResource>(STAKER_MIX_TTL_MS);

async function buildStakerMix(
  blocks: number,
  at: number | undefined,
): Promise<JsonApiResource> {
  // Latest block at-or-before the anchor.
  const tipRows = at !== undefined
    ? await query<{ height: number }>(
      'SELECT height FROM blocks WHERE time <= FROM_UNIXTIME($at) ORDER BY height DESC LIMIT 1',
      { at },
    )
    : await query<{ height: number }>('SELECT height FROM blocks ORDER BY height DESC LIMIT 1');
  const tipHeight = tipRows[0]?.height;
  if (tipHeight === undefined) {
    return {
      type: 'staker_mix',
      id: `last_${blocks}_blocks`,
      attributes: {
        blocks: 0, researcher: 0, investor: 0, researcherSharePct: 0,
      },
    };
  }
  const minHeight = Math.max(0, tipHeight - blocks);
  const row = (await query<{ researcher: number; total: number }>(
    `
      SELECT
        CAST(SUM(CASE WHEN staker_cpid IS NOT NULL AND staker_cpid != '' THEN 1 ELSE 0 END) AS UNSIGNED) AS researcher,
        CAST(count(*) AS UNSIGNED)                                                                        AS total
      FROM blocks
      WHERE height >= $min AND height <= $max
    `,
    { min: minHeight, max: tipHeight },
  ))[0] ?? { researcher: 0, total: 0 };
  return {
    type: 'staker_mix',
    id: `last_${blocks}_blocks`,
    attributes: {
      blocks: row.total,
      researcher: row.researcher,
      investor: row.total - row.researcher,
      researcherSharePct: row.total > 0 ? (row.researcher / row.total) * 100 : 0,
    },
  };
}

metricsRouter.get('/staker-mix', async (req: Request, res: Response) => {
  const blocks = clampedQueryInt(req, 'blocks', { def: 1000, min: 100, max: 10_000 });
  const at = parseAt(req);
  const data = await getStakerMix(
    `${blocks}:${at ?? 'tip'}`,
    () => buildStakerMix(blocks, at),
  );
  res.status(StatusCodes.OK).send(withMeta({ data }));
});
