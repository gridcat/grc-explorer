import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { halford2grc } from '../lib/halford';
import { getTipAnchor } from '../lib/indexerTip';
import { statusOf, waitSecondsOf } from '../lib/mrcStatus';
import { getPagination } from '../lib/pagination';
import { clampedQueryInt } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { tsToUnix } from '../lib/time';

export const mrcRequestsRouter = Router();

interface MrcRow {
  tx_id: string;
  version: number;
  cpid: string;
  client_version: string;
  organization: string;
  research_subsidy: string;
  fee_offered: string;
  magnitude: number;
  magnitude_unit: number;
  last_block_hash: string;
  pay_to_address: string | null;
  first_seen: number | string;
  block_height: number | null;
  block_time: number | string | null;
  evicted_at: number | string | null;
}

function presentRow(r: MrcRow) {
  const firstSeen = tsToUnix(r.first_seen) ?? 0;
  const blockTime = tsToUnix(r.block_time);
  const status = statusOf({ blockHeight: r.block_height, evicted: r.evicted_at !== null });
  const waitSeconds = waitSecondsOf({ blockHeight: r.block_height, firstSeen, blockTime });
  return {
    txId: r.tx_id,
    version: r.version,
    cpid: r.cpid,
    clientVersion: r.client_version,
    organization: r.organization,
    researchSubsidy: halford2grc(BigInt(r.research_subsidy)),
    feeOffered: halford2grc(BigInt(r.fee_offered)),
    magnitude: r.magnitude,
    magnitudeUnit: r.magnitude_unit,
    lastBlockHash: r.last_block_hash,
    payToAddress: r.pay_to_address,
    firstSeen,
    blockHeight: r.block_height,
    blockTime,
    status,
    waitSeconds,
  };
}

// Shared SQL fragment that pulls eviction info from mempool_txs in one
// LEFT JOIN. mrc_requests has no eviction column of its own — eviction
// lives on the same tx_id in mempool_txs.
const SELECT_MRC = `
  SELECT
    m.tx_id                        AS tx_id,
    m.version                      AS version,
    m.cpid                         AS cpid,
    m.client_version               AS client_version,
    m.organization                 AS organization,
    toString(m.research_subsidy)   AS research_subsidy,
    toString(m.fee_offered)        AS fee_offered,
    m.magnitude                    AS magnitude,
    m.magnitude_unit               AS magnitude_unit,
    m.last_block_hash              AS last_block_hash,
    m.pay_to_address               AS pay_to_address,
    toUnixTimestamp(m.first_seen)  AS first_seen,
    m.block_height                 AS block_height,
    toUnixTimestamp(m.block_time)  AS block_time,
    toUnixTimestamp(mt.evicted_at) AS evicted_at
  FROM mrc_requests AS m FINAL
  ANY LEFT JOIN mempool_txs AS mt FINAL ON mt.tx_id = m.tx_id
`;

// Whitelist of sortable columns mapped to their SQL expression. Inputs
// outside this set fall back to the default (newest first) so a typo'd
// `?sort=foo` can't either error or open a SQL-injection path. Type
// derived `as const` so a future contributor adding a column gets a
// compile-time nudge to keep the frontend's `SORT_FIELDS` in sync.
const SORTABLE = {
  first_seen: 'm.first_seen',
  block_height: 'm.block_height',
  research_subsidy: 'm.research_subsidy',
  fee_offered: 'm.fee_offered',
} as const satisfies Record<string, string>;
type SortField = keyof typeof SORTABLE;

function parseSort(raw: unknown): { sql: string; field: SortField; dir: 'ASC' | 'DESC' } {
  const value = typeof raw === 'string' ? raw : '';
  const dir = value.startsWith('-') ? 'DESC' : 'ASC';
  const field = value.replace(/^-/, '') as SortField;
  const column = (SORTABLE as Record<string, string>)[field];
  if (!column) {
    return { sql: `${SORTABLE.first_seen} DESC`, field: 'first_seen', dir: 'DESC' };
  }
  // `block_height` is nullable (pending / evicted rows). Force NULLs
  // to the trailing position regardless of dir so confirmed rows
  // always sort first.
  const nullsClause = field === 'block_height' ? ' NULLS LAST' : '';
  return { sql: `${column} ${dir}${nullsClause}`, field, dir };
}

// GET /mrc-requests
//   filters: ?cpid=... ?status=pending|confirmed|evicted
//   sort: ?sort=[-]first_seen|block_height|research_subsidy|fee_offered
//   pagination: page[size], page[offset]
mrcRequestsRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const cpid = typeof req.query.cpid === 'string' && req.query.cpid.length === 32
    ? req.query.cpid.toLowerCase()
    : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const sort = parseSort(req.query.sort);

  const filters: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (cpid) {
    filters.push('m.cpid = {cpid: String}');
    params.cpid = cpid;
  }
  if (status === 'confirmed') filters.push('m.block_height IS NOT NULL');
  else if (status === 'pending') filters.push('m.block_height IS NULL AND mt.evicted_at IS NULL');
  else if (status === 'evicted') filters.push('m.block_height IS NULL AND mt.evicted_at IS NOT NULL');
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        ${SELECT_MRC}
        ${where}
        ORDER BY ${sort.sql}
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT count() AS c
        FROM mrc_requests AS m FINAL
        ANY LEFT JOIN mempool_txs AS mt FINAL ON mt.tx_id = m.tx_id
        ${where}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowsResult.json<MrcRow>()).map(presentRow);
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);
  res.status(StatusCodes.OK).send(withMeta({
    data: rows.map((r) => ({ id: r.txId, type: 'mrc_request', attributes: r })),
    meta: { count: total },
  }));
});

// GET /mrc-requests/summary
//   Headline numbers for the dashboard: lifetime totals + 24h activity.
mrcRequestsRouter.get('/summary', async (_req: Request, res: Response) => {
  // "Last 24h" is anchored on the indexer cursor, not wall-clock —
  // during a deep backfill the freshest block_time may be months behind
  // now(), and the wall-clock window would always read zero.
  const anchor = await getTipAnchor();
  // Two independent CH queries — pending/evicted breakdown needs the
  // mempool_txs JOIN, totals don't. Run in parallel to save a round trip.
  const [result, statusResult] = await Promise.all([
    ch.query({
      query: `
        SELECT
          toUInt32(countIf(block_height IS NOT NULL))                                            AS confirmed_count,
          toString(sumIf(research_subsidy, block_height IS NOT NULL))                            AS confirmed_research_total,
          toString(sumIf(fee_offered, block_height IS NOT NULL))                                 AS confirmed_fee_total,
          toUInt32(countIf(first_seen >= toDateTime({anchor: UInt64}) - 86400))                  AS recent_count,
          toString(sumIf(research_subsidy, first_seen >= toDateTime({anchor: UInt64}) - 86400))  AS recent_research_total,
          toUInt32(uniqIf(cpid, block_height IS NOT NULL))                                       AS distinct_cpids
        FROM mrc_requests FINAL
      `,
      query_params: { anchor },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT
          toUInt32(countIf(m.block_height IS NULL AND mt.evicted_at IS NULL))     AS pending,
          toUInt32(countIf(m.block_height IS NULL AND mt.evicted_at IS NOT NULL)) AS evicted
        FROM mrc_requests AS m FINAL
        ANY LEFT JOIN mempool_txs AS mt FINAL ON mt.tx_id = m.tx_id
      `,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = await result.json<{
    confirmed_count: number;
    confirmed_research_total: string;
    confirmed_fee_total: string;
    recent_count: number;
    recent_research_total: string;
    distinct_cpids: number;
  }>();
  const r = rows[0] ?? {
    confirmed_count: 0,
    confirmed_research_total: '0',
    confirmed_fee_total: '0',
    recent_count: 0,
    recent_research_total: '0',
    distinct_cpids: 0,
  };
  const status = (await statusResult.json<{ pending: number; evicted: number }>())[0]
    ?? { pending: 0, evicted: 0 };

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mrc_summary',
      id: 'now',
      attributes: {
        confirmedCount: r.confirmed_count,
        confirmedResearchTotal: halford2grc(BigInt(r.confirmed_research_total)),
        confirmedFeeTotal: halford2grc(BigInt(r.confirmed_fee_total)),
        last24hCount: r.recent_count,
        last24hResearchTotal: halford2grc(BigInt(r.recent_research_total)),
        distinctCpids: r.distinct_cpids,
        pendingCount: status.pending,
        evictedCount: status.evicted,
      },
    },
  }));
});

// GET /mrc-requests/timeline?days=N
//   One bucket per UTC day for the last N days (default 30, max 365).
//   Counts confirmed MRCs only — pending/evicted shouldn't smear the
//   "throughput" view.
mrcRequestsRouter.get('/timeline', async (req: Request, res: Response) => {
  const days = clampedQueryInt(req, 'days', { def: 30, min: 1, max: 365 });
  const anchor = await getTipAnchor();

  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toStartOfDay(block_time)) AS bucket_ts,
        toUInt32(count())                         AS count,
        toString(sum(research_subsidy))           AS research_total,
        toString(sum(fee_offered))                AS fee_total,
        toUInt32(uniq(cpid))                      AS distinct_cpids
      FROM mrc_requests FINAL
      WHERE block_height IS NOT NULL
        AND block_time >= toDateTime({anchor: UInt64}) - {seconds: UInt32}
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `,
    query_params: { anchor, seconds: days * 86400 },
    format: 'JSONEachRow',
  });
  const samples = (await result.json<{
    bucket_ts: number; count: number;
    research_total: string; fee_total: string; distinct_cpids: number;
  }>()).map((s) => ({
    ts: s.bucket_ts,
    count: s.count,
    researchTotal: halford2grc(BigInt(s.research_total)),
    feeTotal: halford2grc(BigInt(s.fee_total)),
    distinctCpids: s.distinct_cpids,
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mrc_timeline',
      id: `last_${days}d`,
      attributes: { days, samples },
    },
  }));
});

// GET /mrc-requests/wait-distribution?days=N
//   Histogram of mempool wait time (block_time - first_seen) for
//   confirmed MRCs the watcher actually saw enter the mempool. Excludes
//   historical replay rows where first_seen == block_time.
mrcRequestsRouter.get('/wait-distribution', async (req: Request, res: Response) => {
  const days = clampedQueryInt(req, 'days', { def: 90, min: 1, max: 730 });

  // Buckets in seconds: < 30s, 30–60s, 1–5m, 5–15m, 15m–1h, 1–6h, > 6h.
  const result = await ch.query({
    query: `
      WITH (toUnixTimestamp(block_time) - toUnixTimestamp(first_seen)) AS wait_s
      SELECT
        toUInt32(countIf(wait_s < 30))                       AS b_lt30s,
        toUInt32(countIf(wait_s >= 30 AND wait_s < 60))      AS b_30s_1m,
        toUInt32(countIf(wait_s >= 60 AND wait_s < 300))     AS b_1m_5m,
        toUInt32(countIf(wait_s >= 300 AND wait_s < 900))    AS b_5m_15m,
        toUInt32(countIf(wait_s >= 900 AND wait_s < 3600))   AS b_15m_1h,
        toUInt32(countIf(wait_s >= 3600 AND wait_s < 21600)) AS b_1h_6h,
        toUInt32(countIf(wait_s >= 21600))                   AS b_gt6h,
        quantile(0.5)(wait_s)                                AS p50,
        quantile(0.95)(wait_s)                               AS p95
      FROM mrc_requests FINAL
      WHERE block_height IS NOT NULL
        AND block_time > first_seen
        AND first_seen >= now() - {seconds: UInt32}
    `,
    query_params: { seconds: days * 86400 },
    format: 'JSONEachRow',
  });
  const r = (await result.json<{
    b_lt30s: number; b_30s_1m: number; b_1m_5m: number; b_5m_15m: number;
    b_15m_1h: number; b_1h_6h: number; b_gt6h: number;
    p50: number | null; p95: number | null;
  }>())[0] ?? {
    b_lt30s: 0,
    b_30s_1m: 0,
    b_1m_5m: 0,
    b_5m_15m: 0,
    b_15m_1h: 0,
    b_1h_6h: 0,
    b_gt6h: 0,
    p50: null,
    p95: null,
  };

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mrc_wait_distribution',
      id: `last_${days}d`,
      attributes: {
        days,
        buckets: [
          { label: '<30s', count: r.b_lt30s },
          { label: '30s–1m', count: r.b_30s_1m },
          { label: '1–5m', count: r.b_1m_5m },
          { label: '5–15m', count: r.b_5m_15m },
          { label: '15m–1h', count: r.b_15m_1h },
          { label: '1–6h', count: r.b_1h_6h },
          { label: '>6h', count: r.b_gt6h },
        ],
        p50Seconds: r.p50,
        p95Seconds: r.p95,
      },
    },
  }));
});

// GET /mrc-requests/bid-vs-payout?days=N&limit=K
//   Sample of (research_subsidy, fee_offered) pairs for confirmed MRCs.
//   Caps row count so the scatter doesn't ship megabytes — uses a
//   deterministic sample so chart fidelity is preserved across reloads.
mrcRequestsRouter.get('/bid-vs-payout', async (req: Request, res: Response) => {
  const days = clampedQueryInt(req, 'days', { def: 30, min: 1, max: 365 });
  const limit = clampedQueryInt(req, 'limit', { def: 500, min: 1, max: 5000 });
  const anchor = await getTipAnchor();

  const result = await ch.query({
    query: `
      SELECT
        toString(research_subsidy)    AS research_subsidy,
        toString(fee_offered)         AS fee_offered,
        toUnixTimestamp(block_time)   AS block_time,
        cpid
      FROM mrc_requests FINAL
      WHERE block_height IS NOT NULL
        AND block_time >= toDateTime({anchor: UInt64}) - {seconds: UInt32}
      ORDER BY block_time DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { anchor, seconds: days * 86400, limit },
    format: 'JSONEachRow',
  });
  const points = (await result.json<{
    research_subsidy: string; fee_offered: string; block_time: number; cpid: string;
  }>()).map((p) => ({
    researchSubsidy: halford2grc(BigInt(p.research_subsidy)),
    feeOffered: halford2grc(BigInt(p.fee_offered)),
    blockTime: p.block_time,
    cpid: p.cpid,
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mrc_bid_vs_payout',
      id: `last_${days}d`,
      attributes: { days, limit, points },
    },
  }));
});

// GET /mrc-requests/staker-take?days=N
//   Per-day total of `claims.mrc_staker_fees` and `claims.mrc_foundation_fees`
//   over the last N days. Answers "how much did stakers actually earn
//   from including MRCs?" and "what's the foundation taking?".
//   Source is `claims` (block-level), not `mrc_requests` — these are the
//   chain's own accounting, not derivable from per-request fee_offered.
mrcRequestsRouter.get('/staker-take', async (req: Request, res: Response) => {
  const days = clampedQueryInt(req, 'days', { def: 30, min: 1, max: 365 });
  const anchor = await getTipAnchor();

  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toStartOfDay(block_time)) AS bucket_ts,
        toString(sum(mrc_staker_fees))            AS staker_total,
        toString(sum(mrc_foundation_fees))        AS foundation_total,
        toUInt32(countIf(mrc_staker_fees > 0))    AS mrc_blocks
      FROM claims FINAL
      WHERE block_time >= toDateTime({anchor: UInt64}) - {seconds: UInt32}
        AND (mrc_staker_fees > 0 OR mrc_foundation_fees > 0)
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `,
    query_params: { anchor, seconds: days * 86400 },
    format: 'JSONEachRow',
  });
  const samples = (await result.json<{
    bucket_ts: number; staker_total: string; foundation_total: string; mrc_blocks: number;
  }>()).map((s) => ({
    ts: s.bucket_ts,
    stakerTotal: halford2grc(BigInt(s.staker_total)),
    foundationTotal: halford2grc(BigInt(s.foundation_total)),
    mrcBlocks: s.mrc_blocks,
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mrc_staker_take',
      id: `last_${days}d`,
      attributes: { days, samples },
    },
  }));
});
