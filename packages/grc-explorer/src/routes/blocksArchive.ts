import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { blockUserActivity } from '../lib/blockAggregates';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
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
    query<DailyRow>(
      `
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
      queryParams,
    ),
    query<TxDailyRow>(
      `
        SELECT
          sum(value_moved)   AS value_moved,
          sum(fee_total)     AS fee_total,
          sum(user_tx_count) AS user_tx_count
        FROM archive_txs_daily
        WHERE ${whereSql}
      `,
      queryParams,
    ),
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
    query<{
      year: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>(
      `
        SELECT
          year(bucket_date)     AS year,
          sum(block_count)      AS block_count,
          sum(tx_count)         AS tx_count,
          sum(mint_total)       AS mint_total,
          sum(superblock_count) AS superblock_count
        FROM archive_blocks_daily
        GROUP BY year
        ORDER BY year DESC
      `,
    ),
    query<{
      year: number; value_moved: string; fee_total: string;
    }>(
      `
        SELECT
          year(bucket_date)   AS year,
          sum(value_moved)    AS value_moved,
          sum(fee_total)      AS fee_total
        FROM archive_txs_daily
        GROUP BY year
      `,
    ),
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
    periodStats('year(bucket_date) = $year', { year }),
    query<{
      month: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>(
      `
        SELECT
          month(bucket_date)    AS month,
          sum(block_count)      AS block_count,
          sum(tx_count)         AS tx_count,
          sum(mint_total)       AS mint_total,
          sum(superblock_count) AS superblock_count
        FROM archive_blocks_daily
        WHERE year(bucket_date) = $year
        GROUP BY month
        ORDER BY month ASC
      `,
      { year },
    ),
    query<{ month: number; value_moved: string; fee_total: string }>(
      `
        SELECT
          month(bucket_date)   AS month,
          sum(value_moved)     AS value_moved,
          sum(fee_total)       AS fee_total
        FROM archive_txs_daily
        WHERE year(bucket_date) = $year
        GROUP BY month
      `,
      { year },
    ),
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

  const where = 'year(bucket_date) = $year AND month(bucket_date) = $month';
  const queryParams = { year, month };

  const [stats, daysBlocks, daysTxs] = await Promise.all([
    periodStats(where, queryParams),
    query<{
      day: number; block_count: string; tx_count: string;
      mint_total: string; superblock_count: string;
    }>(
      `
        SELECT
          day(bucket_date) AS day,
          block_count,
          tx_count,
          mint_total,
          superblock_count
        FROM archive_blocks_daily
        WHERE ${where}
        ORDER BY day ASC
      `,
      queryParams,
    ),
    query<{ day: number; value_moved: string; fee_total: string }>(
      `
        SELECT
          day(bucket_date) AS day,
          value_moved,
          fee_total
        FROM archive_txs_daily
        WHERE ${where}
      `,
      queryParams,
    ),
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

  const reqQuery = req.query as Record<string, unknown>;
  const page = (reqQuery.page ?? {}) as Record<string, string | undefined>;
  let pageSize = parseInt(page.size ?? '', 10) || DAY_PAGE_SIZE;
  if (pageSize > DAY_PAGE_MAX) pageSize = DAY_PAGE_MAX;
  if (pageSize < 1) pageSize = DAY_PAGE_SIZE;
  const pageNumber = Math.max(1, parseInt(page.number ?? '', 10) || 1);
  const offset = (pageNumber - 1) * pageSize;

  const where = 'bucket_date = $iso::DATE';
  const blockWhere = 'b.time >= make_timestamp($start::BIGINT * 1000000) AND b.time < make_timestamp($end::BIGINT * 1000000)';

  const [stats, rows] = await Promise.all([
    periodStats(where, { iso }),
    query<{
      height: number; hash: string; time: number | string;
      n_version: number; size: number; tx_count: number;
      is_pos: boolean; miner_address: string | null;
      staker_cpid: string | null; is_superblock: boolean;
      mint: string; difficulty: number | string; is_mrc: boolean | number | null;
    }>(
      // LEFT JOIN claims for the MRC flag — same shape as the /blocks
      // list endpoint (claims is PK by block_height, so the join is a
      // point lookup per row).
      `
        SELECT b.height, b.hash, CAST(epoch(b.time) AS BIGINT) AS time, b.n_version, b.size, b.tx_count, b.is_pos,
               b.miner_address, b.staker_cpid, b.is_superblock, b.mint, b.difficulty, c.is_mrc AS is_mrc
        FROM blocks AS b
        LEFT JOIN claims AS c ON c.block_height = b.height
        WHERE ${blockWhere}
        ORDER BY b.height DESC
        LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}
      `,
      { start: dayStart, end: dayEnd },
    ),
  ]);

  // Per-block user activity (value moved / fees) + staker display names,
  // mirroring the /blocks list endpoint so the archive day table can
  // render the same columns the home ticker does. Both depend only on
  // `rows`, so resolve them concurrently.
  const heights = rows.map((r) => r.height);
  const [aggMap, stakerNames] = await Promise.all([
    blockUserActivity(heights),
    resolveCpidNames(rows.map((r) => r.staker_cpid).filter((c): c is string => !!c)),
  ]);

  const blocks = rows.map((b) => {
    const a = aggMap.get(b.height);
    return {
      height: b.height,
      hash: b.hash,
      time: Number(b.time),
      version: b.n_version,
      size: b.size,
      txCount: b.tx_count,
      isPos: b.is_pos,
      isMrc: Boolean(b.is_mrc),
      minerAddress: b.miner_address,
      stakerCpid: b.staker_cpid,
      stakerName: cpidDisplayName(stakerNames, b.staker_cpid),
      isSuperblock: b.is_superblock,
      difficulty: b.difficulty,
      mintGrc: halford2grc(BigInt(b.mint)),
      valueMoved: halford2grc(BigInt(a?.value_moved ?? '0')),
      feeTotal: halford2grc(BigInt(a?.fee_total ?? '0')),
    };
  });

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
