import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
import { clampedQueryInt } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { tsToUnix } from '../lib/time';
import { parseAt } from '../lib/timeMachine';
import { MempoolTxPresenter } from '../presenters';

export const mempoolRouter = Router();

interface MempoolRow {
  tx_id: string;
  first_seen: number | string;
  fee_estimate: string;
  size: number;
  vin_count: number;
  vout_count: number;
  raw_json: string;
  confirmed_at: number | string | null;
  evicted_at: number | string | null;
  is_mrc: boolean | number;
}

function presentMempoolRow(r: MempoolRow) {
  return {
    ...r,
    first_seen: tsToUnix(r.first_seen) ?? 0,
    fee_estimate: BigInt(r.fee_estimate),
    confirmed_at: tsToUnix(r.confirmed_at),
    evicted_at: tsToUnix(r.evicted_at),
    is_mrc: Boolean(r.is_mrc),
  };
}

// Active mempool at instant T = entered before T, hadn't confirmed or
// been evicted by T. Live mode (T undefined) = "active right now" =
// confirmed_at IS NULL AND evicted_at IS NULL.
//
// `prefix` qualifies the column references for callers that JOIN
// mempool_txs against another table — e.g., 'mp.'. Default empty for
// the single-table case.
function snapshotWhere(
  at: number | undefined,
  prefix = '',
): { sql: string; params: Record<string, unknown> } {
  if (at === undefined) {
    return {
      sql: `${prefix}confirmed_at IS NULL AND ${prefix}evicted_at IS NULL`,
      params: {},
    };
  }
  return {
    sql: `
      ${prefix}first_seen <= make_timestamp($at::BIGINT * 1000000)
      AND (${prefix}confirmed_at IS NULL OR ${prefix}confirmed_at > make_timestamp($at::BIGINT * 1000000))
      AND (${prefix}evicted_at   IS NULL OR ${prefix}evicted_at   > make_timestamp($at::BIGINT * 1000000))
    `,
    params: { at },
  };
}

mempoolRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const at = parseAt(req);
  const w = snapshotWhere(at);
  const wMp = snapshotWhere(at, 'mp.');

  const [rawRows, countRows] = await Promise.all([
    // LEFT JOIN bounds the MRC lookup to the LIMIT-page rows rather than
    // scanning the whole `mrc_requests` table per request. mrc_requests
    // is keyed by tx_id (one row), so a plain LEFT JOIN suffices; a miss
    // yields NULL, hence `mr.tx_id IS NOT NULL` for is_mrc.
    query<MempoolRow>(
      `
        SELECT
          mp.tx_id                          AS tx_id,
          CAST(epoch(mp.first_seen) AS BIGINT)   AS first_seen,
          CAST(mp.fee_estimate AS VARCHAR)       AS fee_estimate,
          mp.size, mp.vin_count, mp.vout_count, mp.raw_json,
          CAST(epoch(mp.confirmed_at) AS BIGINT) AS confirmed_at,
          CAST(epoch(mp.evicted_at) AS BIGINT)   AS evicted_at,
          (mr.tx_id IS NOT NULL)            AS is_mrc
        FROM mempool_txs AS mp
        LEFT JOIN mrc_requests AS mr ON mr.tx_id = mp.tx_id
        WHERE ${wMp.sql}
        ORDER BY mp.first_seen DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `,
      wMp.params,
    ),
    query<{ c: string | number }>(
      `SELECT count(*) AS c FROM mempool_txs WHERE ${w.sql}`,
      w.params,
    ),
  ]);
  const rows = rawRows.map(presentMempoolRow);
  const total = Number(countRows[0]?.c ?? 0);
  const body = MempoolTxPresenter.render(rows, { meta: { count: total, at: at ?? null } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

mempoolRouter.get('/fee-histogram', async (req: Request, res: Response) => {
  const at = parseAt(req);
  const w = snapshotWhere(at);
  const rows = await query<{ fee_estimate: string; size: number }>(
    `
      SELECT CAST(fee_estimate AS VARCHAR) AS fee_estimate, size
      FROM mempool_txs WHERE ${w.sql}
    `,
    w.params,
  );
  const buckets = [0, 1, 5, 25, 100, Number.POSITIVE_INFINITY];
  const counts = new Array(buckets.length - 1).fill(0);
  let totalFees = 0n;
  let totalSize = 0;
  rows.forEach((r) => {
    const fee = BigInt(r.fee_estimate);
    totalFees += fee;
    totalSize += r.size;
    if (r.size === 0) return;
    const rate = Number(fee) / r.size;
    for (let i = 0; i < counts.length; i += 1) {
      if (rate >= buckets[i] && rate < buckets[i + 1]) {
        counts[i] += 1;
        break;
      }
    }
  });
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mempool_fee_histogram',
      id: at ? `at:${at}` : 'now',
      attributes: {
        at: at ?? null,
        count: rows.length,
        totalFees: halford2grc(totalFees),
        totalSize,
        buckets: counts.map((count, i) => ({
          feePerKb: buckets[i] * 1000,
          count,
        })),
      },
    },
  }));
});

mempoolRouter.get('/timeline', async (req: Request, res: Response) => {
  const hours = clampedQueryInt(req, 'hours', { def: 12, min: 1, max: 168 });
  const step = clampedQueryInt(req, 'step', { def: 300, min: 30, max: 3600 });
  const now = Math.floor(Date.now() / 1000);
  const start = now - hours * 3600;

  // One pass with a synthetic time-series instead of N round-trips:
  // unnest a range of sample timestamps, INNER JOIN the mempool rows
  // active at each, and count per bucket. INNER JOIN (not LEFT) so
  // buckets with no active rows are omitted, matching the prior shape.
  const samples = (await query<{
    ts: number; count: number; total_fees: string; total_size: number;
  }>(
    `
      SELECT
        g.sample_ts AS ts,
        CAST(count(*) AS UINTEGER)            AS count,
        CAST(sum(m.fee_estimate) AS VARCHAR)  AS total_fees,
        CAST(sum(m.size) AS UINTEGER)         AS total_size
      FROM (SELECT unnest(range($start::BIGINT, $end::BIGINT + 1, $step::BIGINT)) AS sample_ts) AS g
      JOIN mempool_txs AS m
        ON m.first_seen <= make_timestamp(g.sample_ts * 1000000)
        AND (m.confirmed_at IS NULL OR m.confirmed_at > make_timestamp(g.sample_ts * 1000000))
        AND (m.evicted_at   IS NULL OR m.evicted_at   > make_timestamp(g.sample_ts * 1000000))
      GROUP BY g.sample_ts
      ORDER BY g.sample_ts ASC
    `,
    { start, end: now, step },
  )).map((s) => ({
    ts: s.ts,
    count: s.count,
    totalFees: halford2grc(BigInt(s.total_fees || '0')),
    totalSize: s.total_size,
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mempool_timeline',
      id: `last_${hours}h_step_${step}s`,
      attributes: { hours, step, samples },
    },
  }));
});
