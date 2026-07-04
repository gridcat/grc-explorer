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
      ${prefix}first_seen <= FROM_UNIXTIME($at)
      AND (${prefix}confirmed_at IS NULL OR ${prefix}confirmed_at > FROM_UNIXTIME($at))
      AND (${prefix}evicted_at   IS NULL OR ${prefix}evicted_at   > FROM_UNIXTIME($at))
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
          UNIX_TIMESTAMP(mp.first_seen)     AS first_seen,
          CAST(mp.fee_estimate AS CHAR)     AS fee_estimate,
          mp.size, mp.vin_count, mp.vout_count, mp.raw_json,
          UNIX_TIMESTAMP(mp.confirmed_at)   AS confirmed_at,
          UNIX_TIMESTAMP(mp.evicted_at)     AS evicted_at,
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
      SELECT CAST(fee_estimate AS CHAR) AS fee_estimate, size
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

  // No list/range types in MariaDB, so fetch every mempool row that's
  // active at some point in the window, then build the synthetic time
  // grid in JS and count per bucket. The WHERE bounds rows to those
  // that could be active in [start, now]; the per-sample predicate
  // below reproduces the prior INNER JOIN's active-at-T condition,
  // omitting empty buckets so the response shape is unchanged.
  const activeRows = await query<{
    first_seen: number | string;
    confirmed_at: number | string | null;
    evicted_at: number | string | null;
    fee_estimate: string;
    size: number;
  }>(
    `
      SELECT
        UNIX_TIMESTAMP(first_seen)    AS first_seen,
        UNIX_TIMESTAMP(confirmed_at)  AS confirmed_at,
        UNIX_TIMESTAMP(evicted_at)    AS evicted_at,
        CAST(fee_estimate AS CHAR)    AS fee_estimate,
        size
      FROM mempool_txs
      WHERE first_seen <= FROM_UNIXTIME($end)
        AND (confirmed_at IS NULL OR confirmed_at > FROM_UNIXTIME($start))
        AND (evicted_at   IS NULL OR evicted_at   > FROM_UNIXTIME($start))
    `,
    { start, end: now },
  );

  const txs = activeRows.map((r) => ({
    firstSeen: tsToUnix(r.first_seen) ?? 0,
    confirmedAt: tsToUnix(r.confirmed_at),
    evictedAt: tsToUnix(r.evicted_at),
    fee: BigInt(r.fee_estimate || '0'),
    size: r.size,
  }));

  type Sample = { ts: number; count: number; totalFees: ReturnType<typeof halford2grc>; totalSize: number };
  const samples: Array<Sample> = [];
  for (let ts = start; ts <= now; ts += step) {
    let count = 0;
    let totalFees = 0n;
    let totalSize = 0;
    for (const t of txs) {
      if (t.firstSeen <= ts
        && (t.confirmedAt === null || t.confirmedAt > ts)
        && (t.evictedAt === null || t.evictedAt > ts)) {
        count += 1;
        totalFees += t.fee;
        totalSize += t.size;
      }
    }
    if (count > 0) {
      samples.push({
        ts, count, totalFees: halford2grc(totalFees), totalSize,
      });
    }
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mempool_timeline',
      id: `last_${hours}h_step_${step}s`,
      attributes: { hours, step, samples },
    },
  }));
});
