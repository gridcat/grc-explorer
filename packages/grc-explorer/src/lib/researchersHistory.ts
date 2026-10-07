import { cpidDisplayName, resolveCpidNames } from './cpidNames';
import { maintenanceQuery as query, run } from './db';

// Builders behind /metrics/researchers/history and its series charts.
// The data only changes when a superblock lands, so
// SuperblockPrecomputeJob runs these in the background and stores the
// results in `precomputed_payloads`; routes/metrics.ts reads the stored
// copy and only builds on demand for a key the job hasn't written yet,
// or for a series request larger than PRECOMPUTED_SERIES_LIMIT.
// Builds use the maintenance reader pool so a slow one never holds an
// API request connection.

export interface ResearchersHistoryPoint {
  height: number;
  ts: number;
  date: string;
  active: number;
  totalMagnitude: number;
  top10Magnitude: number;
  top10Share: number;
}

interface ResearchersHistoryRow {
  height: number;
  // UNIX_TIMESTAMP() and the INT counts come off the wire as decimal
  // *strings* (mysql2 read contract), so the types stay honest and the
  // row mapper coerces with Number().
  time: number | string;
  active: number | string;
  total_magnitude: number;
  top10_magnitude: number;
}

export interface SeriesPoint { height: number; magnitude: number }

export interface SeriesEntry {
  cpid: string;
  displayName: string | null;
  points: SeriesPoint[];
}

// Top-N CPIDs stored per series key. Covers the frontend (20) and the
// endpoint default (30); larger `limit`s build on demand.
export const PRECOMPUTED_SERIES_LIMIT = 30;

export const HISTORY_KEY = 'researchers:history';
export const CHAIN_SERIES_KEY = 'researchers:series:chain';
export const YEAR_SERIES_PREFIX = 'researchers:series:year:';
export const yearSeriesKey = (year: number): string => `${YEAR_SERIES_PREFIX}${year}`;

export async function buildResearchersHistory(): Promise<ResearchersHistoryPoint[]> {
  // Reads the superblock_researcher_stats rollup (maintained by
  // RollupMaintainer, seeded in migration 0008): ~3k rows joined to
  // blocks by PK.
  //
  // INNER JOIN on the blocks PK: a superblock only appears once its
  // block row is committed. During backfill the stats row for the
  // newest superblock can land just before the block row (blocks are
  // written last). A LEFT JOIN would emit a NULL time for it, which
  // becomes epoch 0 and drags the chart's x-axis origin back to 1970.
  // INNER JOIN drops that transient row instead.
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

// Top-N CPIDs by total magnitude for a bucket of the cpid_magnitude_totals
// rollup (migration 0020, kept current by RollupMaintainer): a covered
// backward index scan returning N rows. `bucketYear` 0 is all-time; a
// year bucket spans exactly the height range the year series derives, so
// the two rankings agree by construction. An empty bucket (a gap mid
// recompute, or a deployment whose rollup isn't seeded yet) falls back
// to a whole-range GROUP BY over the base table. That is correct, but it
// is the 3.6M-row scan this rollup exists to avoid.
async function topCpids(bucketYear: number, minH: number, maxH: number, limit: number): Promise<string[]> {
  const ranked = await query<{ cpid: string }>(
    `
      SELECT cpid
      FROM cpid_magnitude_totals
      WHERE bucket_year = $y
      ORDER BY total_magnitude DESC
      LIMIT ${Number(limit)}
    `,
    { y: bucketYear },
  );
  if (ranked.length > 0) return ranked.map((r) => r.cpid);
  const fallback = await query<{ cpid: string }>(
    `
      SELECT cpid
      FROM superblock_magnitudes
      WHERE superblock_height >= $minH
        AND superblock_height <= $maxH
        AND magnitude > 0
      GROUP BY cpid
      ORDER BY sum(magnitude) DESC
      LIMIT ${Number(limit)}
    `,
    { minH, maxH },
  );
  return fallback.map((r) => r.cpid);
}

// Top-N series within a height range: for each of the top-N CPIDs
// (ranked by total magnitude across all superblocks in the range),
// return their per-superblock magnitude, every point (callers
// downsample). Powers the multi-line charts on /researchers/history:
// one line per CPID, and hovering a line shows who it is. Used for both the year
// drill-down (bounded by year start/end) and the whole-chain view
// (bounded by genesis/tip).
//
// "Top by total magnitude in the range" weights both height (peak
// magnitude) and persistence (number of superblocks present), which
// surfaces the researchers who *mattered* in that window rather than
// whoever flashed briefly into #1 on a single superblock.
export async function buildSeries(
  bucketYear: number,
  minH: number,
  maxH: number,
  limit: number,
): Promise<SeriesEntry[]> {
  // Two steps: rank the top-N CPIDs, then fetch their per-superblock
  // magnitudes by PK (cpid, superblock_height). `superblock_magnitudes`
  // only has rows for actual superblock heights, so the height range
  // filter is implicit-superblock without a separate join.
  const cpids = await topCpids(bucketYear, minH, maxH, limit);
  if (cpids.length === 0) return [];
  const rows = await query<{ cpid: string; height: number; magnitude: number }>(
    `
      SELECT cpid, superblock_height AS height, magnitude
      FROM superblock_magnitudes
      WHERE cpid IN ($cpids)
        AND superblock_height >= $minH
        AND superblock_height <= $maxH
        AND magnitude > 0
      ORDER BY cpid, superblock_height
    `,
    { cpids, minH, maxH },
  );

  const byCpid = new Map<string, SeriesPoint[]>();
  for (const r of rows) {
    const arr = byCpid.get(r.cpid) ?? [];
    arr.push({ height: r.height, magnitude: r.magnitude });
    byCpid.set(r.cpid, arr);
  }
  // Sort series by total magnitude descending so the frontend can
  // render rank-aware visual cues (palette assignment, label priority
  // on hover collisions), and so slicing the first N gives the top N.
  const series: Array<{ cpid: string; points: SeriesPoint[]; total: number }> = [];
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

// Height range of each calendar year that has superblocks, from the
// chain-wide history. Keeps the year series aligned with whatever the
// chain-wide chart shows.
export function yearRanges(
  history: ResearchersHistoryPoint[],
): Map<number, { minH: number; maxH: number }> {
  const out = new Map<number, { minH: number; maxH: number }>();
  for (const p of history) {
    const year = Number(p.date.slice(0, 4));
    const r = out.get(year);
    if (r) r.maxH = p.height;
    else out.set(year, { minH: p.height, maxH: p.height });
  }
  return out;
}

export function downsampleSeriesPoints(points: SeriesPoint[], maxPoints: number | null): SeriesPoint[] {
  if (maxPoints === null || points.length <= maxPoints) return points;
  if (maxPoints <= 1) return [points[points.length - 1]];
  const sampled: SeriesPoint[] = [];
  const last = points.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(points[Math.round((i * last) / (maxPoints - 1))]);
  }
  return sampled;
}

// Stored payload for `key`, or null when the job hasn't written it yet.
export async function readPrecomputed<T>(key: string): Promise<T | null> {
  const rows = await query<{ payload: string }>(
    'SELECT payload FROM precomputed_payloads WHERE cache_key = $key',
    { key },
  );
  return rows.length > 0 ? JSON.parse(rows[0].payload) as T : null;
}

export async function readPrecomputedHeights(): Promise<Map<string, number>> {
  const rows = await query<{ cache_key: string; source_height: number }>(
    'SELECT cache_key, source_height FROM precomputed_payloads',
  );
  return new Map(rows.map((r) => [r.cache_key, Number(r.source_height)]));
}

export async function writePrecomputed(key: string, sourceHeight: number, payload: unknown): Promise<void> {
  await run(
    `INSERT INTO precomputed_payloads (cache_key, source_height, payload, computed_at)
     VALUES ($key, $h, $payload, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       source_height = VALUES(source_height),
       payload = VALUES(payload),
       computed_at = VALUES(computed_at)`,
    { key, h: sourceHeight, payload: JSON.stringify(payload) },
  );
}

export async function deletePrecomputed(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await run('DELETE FROM precomputed_payloads WHERE cache_key IN ($keys)', { keys });
}
