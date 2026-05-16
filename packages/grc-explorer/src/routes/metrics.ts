import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
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
  const latestResult = await ch.query({
    query: `SELECT max(bucket_ts) AS bt FROM ${table} WHERE bucket_ts <= {at: UInt32}`,
    query_params: { at: anchor },
    format: 'JSONEachRow',
  });
  const latest = (await latestResult.json<{ bt: number | null }>())[0];
  const rightEdge = latest?.bt ?? anchor;
  const since = rightEdge - hours * 3600;

  // Pull rolled-up base metrics from the MV. Pull derived metrics
  // (research, beacons, staker mix) per-bucket from the source tables
  // by binning on the same boundary the MV uses.
  const [bucketsResult, derivedResult, txResult] = await Promise.all([
    ch.query({
      // SummingMergeTree auto-collapses duplicate-key rows on merge, but
      // unmerged rows may still exist between merges. Aggregate at read
      // time so the result is correct regardless of merge state.
      query: `
        SELECT
          bucket_ts,
          toUInt32(sum(block_count))   AS block_count,
          toUInt32(sum(tx_count))      AS tx_count,
          toString(sum(mint_total))    AS mint_total,
          toUInt32(sum(bytes_total))   AS bytes_total
        FROM ${table}
        WHERE bucket_ts >= {since: UInt32} AND bucket_ts <= {end: UInt32}
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge },
      format: 'JSONEachRow',
    }),
    ch.query({
      // Force `bucket_ts` to UInt32 so JSONEachRow ships it as a JSON
      // number (CH defaults wider int types to JSON strings). The
      // bucket-key Map.get on the JS side has to match the network_5m
      // MV's UInt32 bucket_ts; a number-vs-string mismatch makes every
      // lookup miss and the chart goes empty.
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), {step: UInt32}) * {step: UInt32}) AS bucket_ts,
          toString(sum(coalesce(c.research_subsidy, 0)))                       AS research_subsidy_total,
          toString(sum(coalesce(c.block_subsidy, 0)))                          AS block_subsidy_total,
          toUInt32(countIf(b.staker_cpid IS NOT NULL AND b.staker_cpid != '')) AS researcher_blocks,
          toUInt32(countIf(b.staker_cpid IS NULL OR b.staker_cpid = ''))       AS investor_blocks
        FROM blocks AS b FINAL
        LEFT JOIN claims AS c FINAL ON c.block_height = b.height
        WHERE b.time >= toDateTime({since: UInt32})
          AND b.time <= toDateTime({end: UInt32})
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge, step: bucketSec },
      format: 'JSONEachRow',
    }),
    ch.query({
      // Per-bucket transactions aggregate. Excludes coinbase/coinstake
      // (those are reward-emitting txs already accounted via claims —
      // including their total_out would double-count subsidies).
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), {step: UInt32}) * {step: UInt32}) AS bucket_ts,
          toString(sum(total_out)) AS value_moved,
          toString(sum(fee))       AS fee_total
        FROM transactions FINAL
        WHERE NOT is_coinbase AND NOT is_coinstake
          AND time >= toDateTime({since: UInt32})
          AND time <= toDateTime({end: UInt32})
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge, step: bucketSec },
      format: 'JSONEachRow',
    }),
  ]);

  const buckets = await bucketsResult.json<BucketRow>();
  type DerivedRow = {
    bucket_ts: number; research_subsidy_total: string; block_subsidy_total: string;
    researcher_blocks: number; investor_blocks: number;
  };
  type TxBucketRow = { bucket_ts: number; value_moved: string; fee_total: string };
  const derivedByTs = new Map<number, DerivedRow>();
  for (const d of await derivedResult.json<DerivedRow>()) {
    derivedByTs.set(d.bucket_ts, d);
  }
  const txByTs = new Map<number, TxBucketRow>();
  for (const t of await txResult.json<TxBucketRow>()) {
    txByTs.set(t.bucket_ts, t);
  }

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
  const sbResult = await ch.query({
    query: `
      SELECT height FROM superblocks FINAL
      WHERE height <= {h: UInt32}
      ORDER BY height DESC LIMIT {w: UInt32}
    `,
    query_params: { h: latestHeight, w: WINDOW },
    format: 'JSONEachRow',
  });
  const sbHeights = (await sbResult.json<{ height: number }>()).map((r) => r.height);
  if (sbHeights.length === 0) return [];
  const windowMin = sbHeights[sbHeights.length - 1];

  const magResult = await ch.query({
    query: `
      SELECT cpid, superblock_height, magnitude
      FROM superblock_magnitudes FINAL
      WHERE superblock_height >= {min: UInt32} AND superblock_height <= {max: UInt32}
      ORDER BY superblock_height DESC
    `,
    query_params: { min: windowMin, max: latestHeight },
    format: 'JSONEachRow',
  });
  const windowRows = await magResult.json<{ cpid: string; superblock_height: number; magnitude: number }>();

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
  time: number;
  // CH `countIf` returns UInt64, which JSONEachRow serialises as a
  // *string* (precision-preserving). We coerce to Number in the row
  // mapper below, but the type stays honest about what comes off the
  // wire so future callers know to cast.
  active: string;
  total_magnitude: number;
  top10_magnitude: number;
}

async function buildResearchersHistory(): Promise<ResearchersHistoryPoint[]> {
  // One pass over superblock_magnitudes — `arrayReverseSort + arraySlice + arraySum`
  // gives top-10 magnitude per superblock without a window function or
  // self-join. Block time comes from blocks via a final LEFT JOIN on
  // height (cheap; one row per superblock).
  const result = await ch.query({
    query: `
      SELECT
        m.height AS height,
        toUnixTimestamp(b.time) AS time,
        m.active AS active,
        m.total_magnitude AS total_magnitude,
        m.top10_magnitude AS top10_magnitude
      FROM (
        SELECT
          superblock_height AS height,
          countIf(magnitude > 0) AS active,
          sum(magnitude) AS total_magnitude,
          arraySum(arraySlice(arrayReverseSort(groupArrayIf(magnitude, magnitude > 0)), 1, 10)) AS top10_magnitude
        FROM superblock_magnitudes FINAL
        GROUP BY superblock_height
      ) m
      LEFT JOIN (
        -- No FINAL: only superblock heights are needed (the
        -- superblocks table is ~4k rows), so bound blocks to that
        -- set (PK point lookups) and dedup time per height with
        -- argMax(_,_seq). FINAL here was a full blocks merge scan.
        -- The superblock_magnitudes FINAL aggregate above is the
        -- remaining cost (MV territory, see perf-audit memo).
        SELECT height, argMax(time, _seq) AS time
        FROM blocks
        WHERE height IN (SELECT height FROM superblocks)
        GROUP BY height
      ) AS b ON b.height = m.height
      ORDER BY m.height ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await result.json<ResearchersHistoryRow>();
  return rows.map((r) => ({
    height: r.height,
    ts: r.time,
    date: new Date(r.time * 1000).toISOString().slice(0, 10),
    active: Number(r.active),
    totalMagnitude: r.total_magnitude,
    top10Magnitude: r.top10_magnitude,
    top10Share: r.total_magnitude > 0 ? r.top10_magnitude / r.total_magnitude : 0,
  }));
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

async function buildSeries(minH: number, maxH: number, limit: number): Promise<SeriesEntry[]> {
  // Two-step query — pick the top-N CPIDs by total magnitude-days in
  // the height range, then fetch their per-superblock magnitudes.
  // `superblock_magnitudes` only has rows for actual superblock
  // heights, so a height range filter is implicit-superblock without
  // a separate join.
  const result = await ch.query({
    query: `
      WITH top_cpids AS (
        SELECT cpid
        FROM superblock_magnitudes FINAL
        WHERE superblock_height >= {minH: UInt32}
          AND superblock_height <= {maxH: UInt32}
          AND magnitude > 0
        GROUP BY cpid
        ORDER BY sum(magnitude) DESC
        LIMIT {n: UInt32}
      )
      SELECT cpid, superblock_height AS height, magnitude
      FROM superblock_magnitudes FINAL
      WHERE cpid IN (SELECT cpid FROM top_cpids)
        AND superblock_height >= {minH: UInt32}
        AND superblock_height <= {maxH: UInt32}
        AND magnitude > 0
      ORDER BY cpid, superblock_height
    `,
    query_params: { minH, maxH, n: limit },
    format: 'JSONEachRow',
  });
  const rows = await result.json<SeriesRow>();

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
    points,
  }));
}

async function getYearSeries(year: number, limit: number): Promise<SeriesEntry[]> {
  return getCachedSeries(`year:${year}:${limit}`, async () => {
    // Bound height range to the year using the cached chain-wide
    // history. Avoids a separate blocks-table round trip and keeps
    // the filter aligned with whatever the chain-wide chart shows.
    const chain = await getResearchersHistory();
    const inYear = chain.filter((p) => p.date.startsWith(`${year}-`));
    if (inYear.length === 0) return [];
    return buildSeries(inYear[0].height, inYear[inYear.length - 1].height, limit);
  });
}

async function getChainSeries(limit: number): Promise<SeriesEntry[]> {
  return getCachedSeries(`chain:${limit}`, async () => {
    const chain = await getResearchersHistory();
    if (chain.length === 0) return [];
    return buildSeries(chain[0].height, chain[chain.length - 1].height, limit);
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
  const series = await getYearSeries(year, limit);
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
  const series = await getChainSeries(limit);
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
  const result = await ch.query({
    query: `
      WITH active AS (
        SELECT address
        FROM (
          SELECT address, argMax(status, block_height) AS status
          FROM mandatory_sidestakes FINAL
          GROUP BY address
        )
        WHERE status = 'MANDATORY'
      )
      SELECT
        toString(toUInt256(sumIf(amount, time >= toDateTime({since: UInt32})))) AS amount_24h,
        toUInt32(countIf(time >= toDateTime({since: UInt32})))                  AS count_24h,
        toString(toUInt256(sum(amount)))                                         AS amount_all,
        toUInt32(count())                                                        AS count_all,
        toUInt32((SELECT count() FROM active))                                   AS active_recipients
      FROM coinstake_sidestakes FINAL
    `,
    query_params: { since: since24h },
    format: 'JSONEachRow',
  });
  const row = (await result.json<{
    amount_24h: string; count_24h: number;
    amount_all: string; count_all: number;
    active_recipients: number;
  }>())[0] ?? {
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
    const result = await ch.query({
      query: `
        SELECT
          toString(sum(c.research_subsidy))                                  AS research_subsidy,
          toString(sum(c.block_subsidy))                                     AS block_subsidy,
          toUInt32(countIf(b.staker_cpid IS NOT NULL AND b.staker_cpid != '')) AS researcher_blocks,
          toUInt32(countIf(b.staker_cpid IS NULL OR b.staker_cpid = ''))       AS investor_blocks
        FROM blocks AS b FINAL
        LEFT JOIN claims AS c FINAL ON c.block_height = b.height
        WHERE b.time >= toDateTime({since: UInt32}) AND b.time <= toDateTime({end: UInt32})
      `,
      query_params: { since, end: at },
      format: 'JSONEachRow',
    });
    const row = (await result.json<{
      research_subsidy: string; block_subsidy: string;
      researcher_blocks: number; investor_blocks: number;
    }>())[0] ?? {
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
    const result = await ch.query({
      query: `
        SELECT
          toUInt32(countIf(timestamp <= toDateTime({end: UInt32}) AND expiration > toDateTime({end: UInt32}) AND status != 'revoked')) AS active,
          toUInt32(countIf(timestamp >= toDateTime({since: UInt32}) AND timestamp <= toDateTime({end: UInt32}) AND status != 'revoked')) AS new_,
          toUInt32(countIf(expiration >= toDateTime({since: UInt32}) AND expiration < toDateTime({end: UInt32}))) AS expired_
        FROM beacons FINAL
      `,
      query_params: { since, end: evalAt },
      format: 'JSONEachRow',
    });
    const row = (await result.json<{ active: number; new_: number; expired_: number }>())[0]
      ?? { active: 0, new_: 0, expired_: 0 };
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
    const result = await ch.query({
      query: `
        SELECT
          toUnixTimestamp(bucket_ts) AS bucket_ts,
          toString(total_supply)     AS total_supply,
          addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share,
          active_24h, new_24h, hodler_30d, hodler_180d
        FROM wealth_snapshots
        WHERE bucket_ts <= toDateTime({at: UInt32})
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      query_params: { at },
      format: 'JSONEachRow',
    });
    const snap = (await result.json<{
      bucket_ts: number; total_supply: string; addresses_with_balance: number;
      gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
      active_24h: number; new_24h: number; hodler_30d: number; hodler_180d: number;
    }>())[0] ?? null;
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
    const result = await ch.query({
      query: `
        SELECT
          toUnixTimestamp(bucket_ts) AS bucket_ts,
          toString(total_supply)     AS total_supply,
          addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share
        FROM wealth_snapshots
        WHERE bucket_ts >= toDateTime({from: UInt32}) AND bucket_ts <= toDateTime({to: UInt32})
        ORDER BY bucket_ts ASC
      `,
      query_params: { from: fromTs, to: toTs },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{
      bucket_ts: number; total_supply: string; addresses_with_balance: number;
      gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
    }>();
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
  const [latestInRangeResult, latestEverResult, totalResult] = await Promise.all([
    ch.query({
      query: `
        SELECT bucket_ts FROM fee_quantiles_1h
        WHERE bucket_ts <= {at: UInt32}
        GROUP BY bucket_ts
        HAVING countMerge(tx_count_state) > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      query_params: { at: anchor },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT bucket_ts, countMerge(tx_count_state) AS tx_count
        FROM fee_quantiles_1h
        GROUP BY bucket_ts
        HAVING tx_count > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT count() AS c FROM (
          SELECT bucket_ts FROM fee_quantiles_1h
          GROUP BY bucket_ts
          HAVING countMerge(tx_count_state) > 0
        )
      `,
      format: 'JSONEachRow',
    }),
  ]);
  const latestInRange = (await latestInRangeResult.json<{ bucket_ts: number }>())[0];
  const latestEver = (await latestEverResult.json<{ bucket_ts: number; tx_count: string | number }>())[0];
  const totalRow = (await totalResult.json<{ c: string | number }>())[0];

  const rightEdge = latestInRange?.bucket_ts ?? anchor;
  const since = rightEdge - hours * 3600;

  // HAVING tx_count > 0 filters out zero-count buckets. The MV
  // shouldn't generate them in theory (GROUP BY emits only matching
  // rows), but partial states can collapse to 0 in pathological
  // cases (e.g. early transactions inserted before the size lookup
  // fix landed, where all rows had size=0 and got dropped by the
  // WHERE filter — leaving no input but somehow a bucket entry).
  // Filtering at read time keeps the chart honest regardless.
  const result = await ch.query({
    query: `
      SELECT
        bucket_ts,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[1])) AS p50,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[2])) AS p95,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[3])) AS p99,
        countMerge(tx_count_state) AS tx_count
      FROM fee_quantiles_1h
      WHERE bucket_ts >= {since: UInt32} AND bucket_ts <= {end: UInt32}
      GROUP BY bucket_ts
      HAVING tx_count > 0
      ORDER BY bucket_ts ASC
    `,
    query_params: { since, end: rightEdge },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    bucket_ts: number; p50: string; p95: string; p99: string; tx_count: string | number;
  }>();
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
  const result = await ch.query({
    query: `
      SELECT
        formatDateTime(toStartOfMonth(timestamp), '%Y-%m')      AS cohort,
        toUInt32(count())                                        AS advertised,
        toUInt32(countIf(status != 'revoked'))                   AS confirmed,
        toUInt32(countIf(superseded_at_height IS NOT NULL))      AS renewed,
        toUInt32(countIf(expiration <= toDateTime({now: UInt32}))) AS expired_
      FROM beacons FINAL
      WHERE timestamp >= toDateTime({since: UInt32})
      GROUP BY cohort
      ORDER BY cohort ASC
    `,
    query_params: { now, since },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    cohort: string;
    advertised: string | number;
    confirmed: string | number;
    renewed: string | number;
    expired_: string | number;
  }>();
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
  const cohortResult = await ch.query({
    query: `
      SELECT staker_cpid AS cpid, toUnixTimestamp(min(time)) AS first_ts
      FROM blocks FINAL
      WHERE staker_cpid IS NOT NULL AND staker_cpid != ''
      GROUP BY staker_cpid
      HAVING first_ts >= {start: UInt32} AND first_ts < {end: UInt32}
    `,
    query_params: { start: cohortStart, end: cohortEnd },
    format: 'JSONEachRow',
  });
  const cohortRows = await cohortResult.json<{ cpid: string; first_ts: number }>();
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
  const monthlyResult = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toStartOfMonth(time)) AS bucket_ts,
        toUInt32(uniqExact(staker_cpid))      AS active
      FROM blocks FINAL
      WHERE staker_cpid IN ({cpids: Array(String)})
        AND time >= toDateTime({start: UInt32})
        AND time <  toDateTime({end: UInt32})
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `,
    query_params: { cpids, start: cohortStart, end: horizonEnd },
    format: 'JSONEachRow',
  });
  const monthlyRows = await monthlyResult.json<{ bucket_ts: number; active: number }>();
  const seenByBucket = new Map<number, number>();
  for (const r of monthlyRows) seenByBucket.set(r.bucket_ts, r.active);

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
metricsRouter.get('/active-stakers', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 24, min: 1, max: 168 });
  const at = parseAt(req) ?? await getTipAnchor();
  const since = at - hours * 3600;

  const [headlineResult, seriesResult] = await Promise.all([
    ch.query({
      query: `
        SELECT uniqExact(staker_cpid) AS c
        FROM blocks FINAL
        WHERE time >= toDateTime({since: UInt32}) AND time <= toDateTime({end: UInt32})
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
      `,
      query_params: { since, end: at },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
          toUInt32(uniqExact(staker_cpid))              AS count
        FROM blocks FINAL
        WHERE time >= toDateTime({since: UInt32}) AND time <= toDateTime({end: UInt32})
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: at },
      format: 'JSONEachRow',
    }),
  ]);
  const current = Number((await headlineResult.json<{ c: string | number }>())[0]?.c ?? 0);
  const points = (await seriesResult.json<{ bucket_ts: number; count: number }>()).map((p) => ({
    ts: p.bucket_ts,
    count: Number(p.count),
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'active_stakers',
      id: `last_${hours}h`,
      attributes: {
        hours, anchor: at, current, points,
      },
    },
  }));
});

const STAKER_MIX_TTL_MS = 300_000;
const getStakerMix = swrCachedLiveKeyed<JsonApiResource>(STAKER_MIX_TTL_MS);

async function buildStakerMix(
  blocks: number,
  at: number | undefined,
): Promise<JsonApiResource> {
  // Latest block at-or-before the anchor.
  const tipResult = await ch.query({
    query: at !== undefined
      ? 'SELECT height FROM blocks FINAL WHERE time <= toDateTime({at: UInt32}) ORDER BY height DESC LIMIT 1'
      : 'SELECT height FROM blocks FINAL ORDER BY height DESC LIMIT 1',
    query_params: at !== undefined ? { at } : {},
    format: 'JSONEachRow',
  });
  const tipHeight = (await tipResult.json<{ height: number }>())[0]?.height;
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
  const result = await ch.query({
    query: `
      SELECT
        toUInt32(countIf(staker_cpid IS NOT NULL AND staker_cpid != '')) AS researcher,
        toUInt32(count())                                                AS total
      FROM blocks FINAL
      WHERE height >= {min: UInt32} AND height <= {max: UInt32}
    `,
    query_params: { min: minHeight, max: tipHeight },
    format: 'JSONEachRow',
  });
  const row = (await result.json<{ researcher: number; total: number }>())[0]
    ?? { researcher: 0, total: 0 };
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
