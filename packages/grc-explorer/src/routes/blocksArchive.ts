import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { param } from '../lib/req';
import { registerParamValidators } from '../lib/validators';

/**
 * Date-archive API powering /blocks/YYYY[/MM[/DD]] on the frontend.
 *
 * Backed entirely by archive_blocks_daily / archive_txs_daily MVs from
 * 0005 — every overview query touches at most ~365 daily rows even on
 * a year scope, so the read path is microsecond-cheap and stays flat
 * as the chain grows.
 *
 * The day-leaf endpoint is the only one that hits the base `blocks`
 * table directly: it needs row-level data (hashes, miner addrs) and
 * the YYYYMM partition prunes the scan to a single month's worth of
 * blocks before the `time BETWEEN…` filter narrows further.
 */
export const blocksArchiveRouter = Router();
registerParamValidators(blocksArchiveRouter);

const DAY_PAGE_SIZE = 250;
const DAY_PAGE_MAX = 500;

interface DailyRow {
  bucket_date: string;
  block_count: string | number;
  tx_count: string | number;
  mint_total: string | number;
  bytes_total: string | number;
  pos_count: string | number;
  superblock_count: string | number;
}

interface TxDailyRow {
  bucket_date: string;
  value_moved: string | number;
  fee_total: string | number;
  user_tx_count: string | number;
}

// Sum of selected fields across an arbitrary daily slice. Both MVs
// already collapse to one row per `bucket_date`, but reading them
// directly without the wrapping GROUP BY can still return multiple
// part-local rows pre-merge — explicit GROUP BY collapses them.
function num(v: string | number | undefined): number {
  return Number(v ?? 0);
}

function isYearShape(year: number): boolean {
  return Number.isInteger(year) && year >= 2009 && year <= 2099;
}
function isMonthShape(month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= 12;
}
function isDayShape(day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= 31;
}

function badParam(res: Response, msg: string): void {
  res.status(StatusCodes.BAD_REQUEST).send({
    errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad parameter', msg)],
  });
}

// One-shot "compute the standard period stat row" — used at every
// archive level (year / month / day overview). The narrow column set
// keeps the wire shape uniform across all three so the frontend can
// render a single PeriodStatRow component everywhere.
async function periodStats(whereSql: string, queryParams: Record<string, unknown>) {
  const [blocksAgg, txsAgg] = await Promise.all([
    ch.query({
      query: `
        SELECT
          sum(block_count)      AS block_count,
          sum(tx_count)         AS tx_count,
          sum(mint_total)       AS mint_total,
          sum(bytes_total)      AS bytes_total,
          sum(pos_count)        AS pos_count,
          sum(superblock_count) AS superblock_count
        FROM archive_blocks_daily
        WHERE ${whereSql}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }).then((r) => r.json<DailyRow>()),
    ch.query({
      query: `
        SELECT
          sum(value_moved)   AS value_moved,
          sum(fee_total)     AS fee_total,
          sum(user_tx_count) AS user_tx_count
        FROM archive_txs_daily
        WHERE ${whereSql.replace(/archive_blocks_daily/g, 'archive_txs_daily')}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }).then((r) => r.json<TxDailyRow>()),
  ]);
  const b = blocksAgg[0] ?? {};
  const t = txsAgg[0] ?? {};
  return {
    blockCount: num(b.block_count),
    txCount: num(b.tx_count),
    posCount: num(b.pos_count),
    superblockCount: num(b.superblock_count),
    bytesTotal: num(b.bytes_total),
    mintTotalGrc: halford2grc(BigInt(b.mint_total ?? 0)),
    valueMovedGrc: halford2grc(BigInt(t.value_moved ?? 0)),
    feeTotalGrc: halford2grc(BigInt(t.fee_total ?? 0)),
    userTxCount: num(t.user_tx_count),
  };
}

/**
 * GET /blocks/archive/years
 * Year list with per-year stats. Drives the year-archive rail on
 * /blocks and the index of the historical archive.
 */
blocksArchiveRouter.get('/years', async (_req: Request, res: Response) => {
  const [blocks, txs] = await Promise.all([
    ch.query({
      query: `
        SELECT
          toYear(bucket_date)   AS year,
          sum(block_count)      AS block_count,
          sum(tx_count)         AS tx_count,
          sum(mint_total)       AS mint_total,
          sum(superblock_count) AS superblock_count
        FROM archive_blocks_daily
        GROUP BY year
        ORDER BY year DESC
      `,
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      year: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>()),
    ch.query({
      query: `
        SELECT
          toYear(bucket_date) AS year,
          sum(value_moved)    AS value_moved,
          sum(fee_total)      AS fee_total
        FROM archive_txs_daily
        GROUP BY year
      `,
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      year: number; value_moved: string; fee_total: string;
    }>()),
  ]);

  // Index the tx aggregate by year so the merge is O(N) instead of O(N²).
  const txByYear = new Map<number, { value_moved: string; fee_total: string }>();
  for (const row of txs) txByYear.set(Number(row.year), row);

  const data = blocks.map((b) => {
    const t = txByYear.get(Number(b.year));
    return {
      type: 'archive-year',
      id: String(b.year),
      attributes: {
        year: Number(b.year),
        blockCount: num(b.block_count),
        txCount: num(b.tx_count),
        superblockCount: num(b.superblock_count),
        mintTotalGrc: halford2grc(BigInt(b.mint_total ?? 0)),
        valueMovedGrc: halford2grc(BigInt(t?.value_moved ?? 0)),
        feeTotalGrc: halford2grc(BigInt(t?.fee_total ?? 0)),
      },
    };
  });

  res.status(StatusCodes.OK).send({ data });
});

/**
 * GET /blocks/archive/:year
 * Year overview: stat row + per-month breakdown.
 */
blocksArchiveRouter.get('/:year', async (req: Request, res: Response) => {
  const year = parseInt(param(req, 'year'), 10);
  if (!isYearShape(year)) { badParam(res, `year must be 2009-2099, got ${year}`); return; }

  const [stats, monthsBlocks, monthsTxs] = await Promise.all([
    periodStats('toYear(bucket_date) = {year:UInt16}', { year }),
    ch.query({
      query: `
        SELECT
          toMonth(bucket_date)  AS month,
          sum(block_count)      AS block_count,
          sum(tx_count)         AS tx_count,
          sum(mint_total)       AS mint_total,
          sum(superblock_count) AS superblock_count
        FROM archive_blocks_daily
        WHERE toYear(bucket_date) = {year:UInt16}
        GROUP BY month
        ORDER BY month ASC
      `,
      query_params: { year },
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      month: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>()),
    ch.query({
      query: `
        SELECT
          toMonth(bucket_date) AS month,
          sum(value_moved)     AS value_moved,
          sum(fee_total)       AS fee_total
        FROM archive_txs_daily
        WHERE toYear(bucket_date) = {year:UInt16}
        GROUP BY month
      `,
      query_params: { year },
      format: 'JSONEachRow',
    }).then((r) => r.json<{ month: number; value_moved: string; fee_total: string }>()),
  ]);

  // Empty periods used to 404 here; now we return zero-stats so the
  // frontend can render an "empty period" banner with noindex meta.
  // SEO behaviour is unchanged (search engines still skip the page),
  // but users browsing the archive don't get bounced to Major Tom.
  const txByMonth = new Map<number, { value_moved: string; fee_total: string }>();
  for (const row of monthsTxs) txByMonth.set(Number(row.month), row);

  const months = monthsBlocks.map((m) => {
    const t = txByMonth.get(Number(m.month));
    return {
      month: Number(m.month),
      blockCount: num(m.block_count),
      txCount: num(m.tx_count),
      superblockCount: num(m.superblock_count),
      mintTotalGrc: halford2grc(BigInt(m.mint_total ?? 0)),
      valueMovedGrc: halford2grc(BigInt(t?.value_moved ?? 0)),
      feeTotalGrc: halford2grc(BigInt(t?.fee_total ?? 0)),
    };
  });

  res.status(StatusCodes.OK).send({
    data: {
      type: 'archive-year',
      id: String(year),
      attributes: { year, ...stats, months },
    },
  });
});

/**
 * GET /blocks/archive/:year/:month
 * Month overview: stat row + per-day breakdown for the calendar grid.
 */
blocksArchiveRouter.get('/:year/:month', async (req: Request, res: Response) => {
  const year = parseInt(param(req, 'year'), 10);
  const month = parseInt(param(req, 'month'), 10);
  if (!isYearShape(year)) { badParam(res, `year must be 2009-2099, got ${year}`); return; }
  if (!isMonthShape(month)) { badParam(res, `month must be 1-12, got ${month}`); return; }

  const where = 'toYear(bucket_date) = {year:UInt16} AND toMonth(bucket_date) = {month:UInt8}';
  const queryParams = { year, month };

  const [stats, daysBlocks, daysTxs] = await Promise.all([
    periodStats(where, queryParams),
    ch.query({
      query: `
        SELECT
          toDayOfMonth(bucket_date) AS day,
          block_count,
          tx_count,
          mint_total,
          superblock_count
        FROM archive_blocks_daily
        WHERE ${where}
        ORDER BY day ASC
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      day: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>()),
    ch.query({
      query: `
        SELECT
          toDayOfMonth(bucket_date) AS day,
          value_moved,
          fee_total
        FROM archive_txs_daily
        WHERE ${where}
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    }).then((r) => r.json<{ day: number; value_moved: string; fee_total: string }>()),
  ]);

  const txByDay = new Map<number, { value_moved: string; fee_total: string }>();
  for (const row of daysTxs) txByDay.set(Number(row.day), row);

  const days = daysBlocks.map((d) => {
    const t = txByDay.get(Number(d.day));
    return {
      day: Number(d.day),
      blockCount: num(d.block_count),
      txCount: num(d.tx_count),
      superblockCount: num(d.superblock_count),
      mintTotalGrc: halford2grc(BigInt(d.mint_total ?? 0)),
      valueMovedGrc: halford2grc(BigInt(t?.value_moved ?? 0)),
      feeTotalGrc: halford2grc(BigInt(t?.fee_total ?? 0)),
    };
  });

  res.status(StatusCodes.OK).send({
    data: {
      type: 'archive-month',
      id: `${year}-${String(month).padStart(2, '0')}`,
      attributes: {
        year, month, ...stats, days,
      },
    },
  });
});

/**
 * GET /blocks/archive/:year/:month/:day
 * Day leaf: stat row + paginated block list (newest-first within day).
 *
 * Query params:
 *   page[size]   default 250, max 500
 *   page[number] 1-based
 */
blocksArchiveRouter.get('/:year/:month/:day', async (req: Request, res: Response) => {
  const year = parseInt(param(req, 'year'), 10);
  const month = parseInt(param(req, 'month'), 10);
  const day = parseInt(param(req, 'day'), 10);
  if (!isYearShape(year)) { badParam(res, `year must be 2009-2099, got ${year}`); return; }
  if (!isMonthShape(month)) { badParam(res, `month must be 1-12, got ${month}`); return; }
  if (!isDayShape(day)) { badParam(res, `day must be 1-31, got ${day}`); return; }

  // toDate({iso}) catches Feb 30 etc. by returning 1970-01-01 — we
  // cross-check against the input components below so a malformed
  // date returns 400 rather than silently aliasing to the epoch.
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== year
      || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) {
    badParam(res, `invalid date ${iso}`); return;
  }

  const dayStart = Math.floor(dt.getTime() / 1000);
  const dayEnd = dayStart + 86400;

  const query = req.query as Record<string, unknown>;
  const page = (query.page ?? {}) as Record<string, string | undefined>;
  let pageSize = parseInt(page.size ?? '', 10) || DAY_PAGE_SIZE;
  if (pageSize > DAY_PAGE_MAX) pageSize = DAY_PAGE_MAX;
  if (pageSize < 1) pageSize = DAY_PAGE_SIZE;
  const pageNumber = Math.max(1, parseInt(page.number ?? '', 10) || 1);
  const offset = (pageNumber - 1) * pageSize;

  const where = 'bucket_date = toDate({iso:String})';
  const blockWhere = 'time >= toDateTime({start:UInt32}) AND time < toDateTime({end:UInt32})';

  const [stats, rows] = await Promise.all([
    periodStats(where, { iso }),
    ch.query({
      query: `
        SELECT height, hash, time, n_version, size, tx_count, is_pos,
               miner_address, staker_cpid, is_superblock, mint
        FROM blocks FINAL
        WHERE ${blockWhere}
        ORDER BY height DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `,
      query_params: {
        start: dayStart, end: dayEnd, limit: pageSize, offset,
      },
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      height: number; hash: string; time: string;
      n_version: number; size: number; tx_count: number;
      is_pos: boolean; miner_address: string | null;
      staker_cpid: string | null; is_superblock: boolean;
      mint: string;
    }>()),
  ]);

  const blocks = rows.map((b) => ({
    height: b.height,
    hash: b.hash,
    time: Math.floor(new Date(b.time).getTime() / 1000),
    version: b.n_version,
    size: b.size,
    txCount: b.tx_count,
    isPos: b.is_pos,
    minerAddress: b.miner_address,
    stakerCpid: b.staker_cpid,
    isSuperblock: b.is_superblock,
    mintGrc: halford2grc(BigInt(b.mint)),
  }));

  res.status(StatusCodes.OK).send({
    data: {
      type: 'archive-day',
      id: iso,
      attributes: {
        year,
        month,
        day,
        iso,
        ...stats,
        blocks,
        pagination: {
          pageSize,
          pageNumber,
          totalPages: Math.max(1, Math.ceil(stats.blockCount / pageSize)),
        },
      },
    },
  });
});
