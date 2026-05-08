import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
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
      ${prefix}first_seen <= toDateTime({at: UInt32})
      AND (${prefix}confirmed_at IS NULL OR ${prefix}confirmed_at > toDateTime({at: UInt32}))
      AND (${prefix}evicted_at   IS NULL OR ${prefix}evicted_at   > toDateTime({at: UInt32}))
    `,
    params: { at },
  };
}

mempoolRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const at = parseAt(req);
  const w = snapshotWhere(at);
  const wMp = snapshotWhere(at, 'mp.');

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      // ANY LEFT JOIN bounds the MRC lookup to the LIMIT-page rows
      // rather than scanning the whole `mrc_requests` table per
      // request — the IN-subquery shape we used before re-FINALed
      // every MRC ever observed on every list call.
      query: `
        SELECT
          mp.tx_id                          AS tx_id,
          toUnixTimestamp(mp.first_seen)    AS first_seen,
          toString(mp.fee_estimate)         AS fee_estimate,
          mp.size, mp.vin_count, mp.vout_count, mp.raw_json,
          toUnixTimestamp(mp.confirmed_at)  AS confirmed_at,
          toUnixTimestamp(mp.evicted_at)    AS evicted_at,
          (mr.tx_id != '')                  AS is_mrc
        FROM mempool_txs AS mp FINAL
        ANY LEFT JOIN mrc_requests AS mr FINAL ON mr.tx_id = mp.tx_id
        WHERE ${wMp.sql}
        ORDER BY mp.first_seen DESC
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: { ...wMp.params, limit, offset },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c FROM mempool_txs FINAL WHERE ${w.sql}`,
      query_params: w.params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowsResult.json<MempoolRow>()).map(presentMempoolRow);
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);
  const body = MempoolTxPresenter.render(rows, { meta: { count: total, at: at ?? null } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

mempoolRouter.get('/fee-histogram', async (req: Request, res: Response) => {
  const at = parseAt(req);
  const w = snapshotWhere(at);
  const result = await ch.query({
    query: `
      SELECT toString(fee_estimate) AS fee_estimate, size
      FROM mempool_txs FINAL WHERE ${w.sql}
    `,
    query_params: w.params,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ fee_estimate: string; size: number }>();
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
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '12'), 10) || 12, 1), 168);
  const step = Math.min(Math.max(parseInt(String(req.query.step ?? '300'), 10) || 300, 30), 3600);
  const now = Math.floor(Date.now() / 1000);
  const start = now - hours * 3600;

  // One CH pass with a synthetic time-series via arrayJoin instead of N
  // round-trips like the MySQL version. For each bucket boundary, count
  // rows that were active at that instant.
  const result = await ch.query({
    query: `
      WITH arrayJoin(range(toUInt32({start: UInt32}), toUInt32({end: UInt32}) + 1, toUInt32({step: UInt32}))) AS sample_ts
      SELECT
        sample_ts AS ts,
        count() AS count,
        toString(sum(fee_estimate)) AS total_fees,
        sum(size) AS total_size
      FROM mempool_txs FINAL
      WHERE first_seen <= toDateTime(sample_ts)
        AND (confirmed_at IS NULL OR confirmed_at > toDateTime(sample_ts))
        AND (evicted_at   IS NULL OR evicted_at   > toDateTime(sample_ts))
      GROUP BY sample_ts
      ORDER BY sample_ts ASC
    `,
    query_params: { start, end: now, step },
    format: 'JSONEachRow',
  });
  const samples = (await result.json<{
    ts: number; count: number; total_fees: string; total_size: number;
  }>()).map((s) => ({
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
