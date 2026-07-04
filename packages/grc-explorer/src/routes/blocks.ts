import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import packageJson from '../../package.json';
import { query } from '../lib/db';
import { blockUserActivity } from '../lib/blockAggregates';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
import { getCursor, redis } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { tsToUnix } from '../lib/time';
import { BlockPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';
import { buildBlockFlow } from '../services/blockFlow/buildBlockFlow';

export const blocksRouter = Router();
registerParamValidators(blocksRouter);

interface BlockRow {
  height: number;
  hash: string;
  prev_hash: string;
  merkle_root: string;
  time: number | string;
  n_version: number;
  difficulty: string;
  size: number;
  tx_count: number;
  is_pos: boolean;
  miner_address: string | null;
  staker_cpid: string | null;
  is_superblock: boolean;
  mint: string;
  money_supply: string;
  is_mrc?: boolean | number;
  // Joined at list time from transactions GROUP BY block_height
  // (excluding coinbase/coinstake). Halford strings.
  value_moved?: string;
  fee_total?: string;
  // Server-side resolved BOINC display name for `staker_cpid` (absent
  // when not enriched or anonymous; frontend falls back to the hash).
  staker_name?: string | null;
}

// Presenter expects mint/money_supply as bigint (matches the legacy
// Prisma row shape). DuckDB returns them as decimal strings —
// coerce here so halford2grc gets the bigint it expects.
function presentRow(r: BlockRow): Omit<BlockRow, 'mint' | 'money_supply' | 'is_mrc' | 'value_moved' | 'fee_total'> & {
  mint: bigint;
  money_supply: bigint;
  is_mrc: boolean;
  value_moved: bigint;
  fee_total: bigint;
} {
  return {
    ...r,
    time: tsToUnix(r.time) ?? 0,
    mint: BigInt(r.mint),
    money_supply: BigInt(r.money_supply),
    is_mrc: Boolean(r.is_mrc),
    value_moved: BigInt(r.value_moved ?? '0'),
    fee_total: BigInt(r.fee_total ?? '0'),
  };
}

blocksRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const at = parseInt(String(req.query.at ?? ''), 10);
  const useAt = Number.isFinite(at) && at > 0;

  // The list bounds claims to the page's heights (claims is keyed by
  // block_height); the count and the page-tail subquery share this
  // unaliased time predicate (no `b.` alias inside them).
  const countTimeFilter = useAt ? 'WHERE time <= FROM_UNIXTIME($at)' : '';
  const params = useAt ? { at } : {};

  const [rawRows, totalRows] = await Promise.all([
    // height is the PRIMARY KEY (one row per block via upsert), so the
    // page tail is `ORDER BY height DESC LIMIT/OFFSET` over the height
    // index — no dedup needed. The page's heights bound a LEFT JOIN to
    // claims (also PK by block_height) for the is_mrc flag.
    query<BlockRow>(
      `
        WITH page_heights AS (
          SELECT height
          FROM blocks
          ${countTimeFilter}
          ORDER BY height DESC
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT b.*, c.is_mrc AS is_mrc
        FROM blocks AS b
        LEFT JOIN claims AS c ON c.block_height = b.height
        WHERE b.height IN (SELECT height FROM page_heights)
        ORDER BY b.height DESC
      `,
      params,
    ),
    // Heights are contiguous genesis→tip (HistoricalBackfiller commits
    // strictly in order — no gaps even mid-backfill), so the listable
    // block count is exactly max-min+1. For the `at` path the predicate
    // still prunes via idx_blocks_time. Empty/clamped result → NULL,
    // handled JS-side.
    query<{ c: string | number }>(
      `SELECT CAST(max(height) - min(height) + 1 AS SIGNED) AS c FROM blocks ${countTimeFilter}`,
      params,
    ),
  ]);
  const total = Number(totalRows[0]?.c ?? 0);

  // Per-block user activity (value moved / fees) + staker-name
  // resolution both depend only on rawRows, so run them concurrently —
  // saves one round trip on the SSR path. Staker display names are
  // resolved server-side so the SSR seed (home LiveBlockTicker, /blocks
  // page) renders names without a second /cpids/names round trip.
  const heights = rawRows.map((r) => r.height);
  const [aggMap, stakerNames] = await Promise.all([
    blockUserActivity(heights),
    resolveCpidNames(rawRows.map((r) => r.staker_cpid).filter((c): c is string => !!c)),
  ]);
  const rows = rawRows.map((r) => {
    const a = aggMap.get(r.height);
    return presentRow({
      ...r,
      value_moved: a?.value_moved ?? '0',
      fee_total: a?.fee_total ?? '0',
      staker_name: cpidDisplayName(stakerNames, r.staker_cpid),
    });
  });

  const body = BlockPresenter.render(rows, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

// Deep-confirmed block payloads are immutable — deeper than
// ChainReorgHandler's MAX_REORG_DEPTH (100), no reorg can reach them —
// so the fully rendered response is cached in Redis. A hit costs two
// Redis round trips instead of ~17 DuckDB queries (block + txs + claim
// + MRCs + the whole flow build). The package version in the key busts
// the cache on deploys that change the payload shape; tipHeight is the
// one live field and is re-injected fresh on every hit.
const DETAIL_CACHE_DEPTH = 120;
const DETAIL_CACHE_TTL_S = 24 * 3600;
// Browsers/CDN may hold a copy for 5 minutes (bounding tipHeight
// staleness) and serve stale while revalidating for a day.
const DETAIL_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';
const detailCacheKey = (height: number) => `blockdetail:${packageJson.version}:${height}`;

blocksRouter.get('/:height', async (req: Request, res: Response) => {
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height', 'height must be an integer')],
    });
    return;
  }

  // Only the canonical full variant (?txs not disabled) is cached.
  const cacheable = req.query.txs !== '0';
  if (cacheable) {
    const [cached, cursorNow] = await Promise.all([redis.get(detailCacheKey(height)), getCursor()]);
    if (cached && cursorNow) {
      const cachedBody = JSON.parse(cached) as Record<string, unknown>;
      cachedBody.tipHeight = cursorNow.height;
      res.setHeader('Cache-Control', DETAIL_CACHE_CONTROL);
      res.status(StatusCodes.OK).send(cachedBody);
      return;
    }
  }

  const blockRows = await query<BlockRow>(
    'SELECT * FROM blocks WHERE height = $h LIMIT 1',
    { h: height },
  );
  if (blockRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Block not found')],
    });
    return;
  }
  const row = presentRow(blockRows[0]);

  const includeTxs = req.query.txs !== '0';
  const [txResult, claimResult, mrcResult, cursor] = await Promise.all([
    includeTxs
      ? query<{
        tx_id: string; is_coinbase: boolean; is_coinstake: boolean;
        total_out: string; fee: string; index_in_blk: number;
      }>(
        `
          SELECT tx_id, is_coinbase, is_coinstake, total_out, fee, index_in_blk
          FROM transactions
          WHERE block_height = $h
          ORDER BY index_in_blk ASC
        `,
        { h: height },
      )
      : Promise.resolve([]),
    query<Record<string, unknown>>(
      'SELECT * FROM claims WHERE block_height = $h LIMIT 1',
      { h: height },
    ),
    query<{
      cpid: string; mining_id: string; client_version: string;
      research_subsidy: string; magnitude: number; pay_to_address: string | null;
    }>(
      `
        SELECT cpid, mining_id, client_version, research_subsidy, magnitude, pay_to_address
        FROM claim_mrcs
        WHERE block_height = $h
        ORDER BY CAST(research_subsidy AS UNSIGNED) DESC
      `,
      { h: height },
    ),
    getCursor(),
  ]);

  // One server-side name resolution for everything CPID-bearing on
  // the page (block staker + claim + MRC claims) so BlockDetail's SSR
  // seed needs no /cpids/names round trip.
  const claim = claimResult[0] ?? null;
  const detailNames = await resolveCpidNames([
    blockRows[0].staker_cpid,
    (claim?.cpid as string | null | undefined) ?? null,
    ...mrcResult.map((m) => m.cpid),
  ].filter((c): c is string => !!c));
  row.staker_name = cpidDisplayName(detailNames, blockRows[0].staker_cpid);

  const txAttributes = txResult.map((t) => ({
    txId: t.tx_id,
    isCoinbase: t.is_coinbase,
    isCoinstake: t.is_coinstake,
    totalOut: halford2grc(BigInt(t.total_out)),
    fee: halford2grc(BigInt(t.fee)),
  }));

  const claimAttributes = claim
    ? {
      ...claim,
      cpidName: cpidDisplayName(detailNames, (claim.cpid as string | null | undefined) ?? null),
      block_subsidy: halford2grc(BigInt(claim.block_subsidy as string)),
      research_subsidy: halford2grc(BigInt(claim.research_subsidy as string)),
      mrc_foundation_fees: halford2grc(BigInt((claim.mrc_foundation_fees as string | undefined) ?? '0')),
      mrc_staker_fees: halford2grc(BigInt((claim.mrc_staker_fees as string | undefined) ?? '0')),
    }
    : null;

  const mrcAttributes = mrcResult.map((m) => ({
    cpid: m.cpid,
    cpidName: cpidDisplayName(detailNames, m.cpid),
    miningId: m.mining_id,
    clientVersion: m.client_version,
    researchSubsidy: halford2grc(BigInt(m.research_subsidy)),
    magnitude: m.magnitude,
    payToAddress: m.pay_to_address,
  }));

  // Semantic flow view of the block (minted/transfer/sidestake/data) for
  // the graphical representation below the tx list. Needs the tx list, so
  // it's skipped when txs are excluded.
  const flow = includeTxs
    ? await buildBlockFlow(
      height,
      txResult.map((t) => ({ txId: t.tx_id, isCoinbase: t.is_coinbase, isCoinstake: t.is_coinstake })),
      claim
        ? {
          cpid: (claim.cpid as string | null) ?? null,
          block_subsidy: (claim.block_subsidy as string | null) ?? null,
          research_subsidy: (claim.research_subsidy as string | null) ?? null,
          magnitude: (claim.magnitude as number | null) ?? null,
          is_mrc: (claim.is_mrc as boolean | null) ?? null,
          mrc_foundation_fees: (claim.mrc_foundation_fees as string | null) ?? null,
          mrc_staker_fees: (claim.mrc_staker_fees as string | null) ?? null,
        }
        : null,
    )
    : null;

  const body = BlockPresenter.render(row);
  const responseBody = withMeta(body, {
    transactions: txAttributes,
    claim: claimAttributes,
    mrcs: mrcAttributes,
    flow,
    tipHeight: cursor?.height ?? row.height,
  }) as Record<string, unknown>;

  const tip = cursor?.height ?? row.height;
  if (cacheable && cursor && tip - height >= DETAIL_CACHE_DEPTH) {
    res.setHeader('Cache-Control', DETAIL_CACHE_CONTROL);
    // tipHeight is stripped (zeroed) in the stored copy and re-injected
    // fresh on every hit.
    await redis.set(
      detailCacheKey(height),
      JSON.stringify({ ...responseBody, tipHeight: 0 }),
      'EX',
      DETAIL_CACHE_TTL_S,
    );
  }
  res.status(StatusCodes.OK).send(responseBody);
});

blocksRouter.get('/hash/:hash', async (req: Request, res: Response) => {
  const rows = await query<{ height: number }>(
    'SELECT height FROM blocks WHERE hash = $hash LIMIT 1',
    { hash: param(req, 'hash') },
  );
  if (rows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Block not found')],
    });
    return;
  }
  res.redirect(302, `/blocks/${rows[0].height}`);
});

interface SnapshotRow {
  block_hash: string;
  block_time: number | string;
  captured_at: number | string;
  tx_id: string;
  first_seen: number | string;
  fee_estimate: string;
  size: number;
  vin_count: number;
  vout_count: number;
  was_included: boolean | number;
}

// Per-block mempool snapshot — what was sitting in mempool when this
// block landed. `was_included` flags the txs this same block then
// Mandatory-sidestake payouts attached to this block's coinstake.
// Joined with the registry at the block's height so each row carries
// the recipient's allocation_pct and description as-of that block.
// Empty for pre-V13 blocks (the parser doesn't capture coinstake
// extras there). 200 OK with empty payouts is the steady-state for
// the vast majority of blocks even post-V13 — the home tile uses
// /metrics/mandatory-sidestakes for aggregates instead.
blocksRouter.get('/:height/sidestakes', async (req: Request, res: Response) => {
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height', 'height must be an integer')],
    });
    return;
  }
  // Registry-at-height = last row per address with block_height <= H,
  // filtered to status='MANDATORY'. Same shape as in
  // mandatorySidestakes.ts but scoped to this height for the LEFT JOIN.
  const rows = await query<{
    address: string; vout_idx: number; tx_id: string;
    amount: string; time: number;
    allocation_pct: number; description: string; status: string;
  }>(
    `
      WITH registry AS (
        -- last row per address (max block_height <= H); arg_max ->
        -- ROW_NUMBER()=1 over block_height DESC.
        SELECT address, status, allocation_pct, description
        FROM (
          SELECT address, status, allocation_pct, description,
                 ROW_NUMBER() OVER (PARTITION BY address ORDER BY block_height DESC) AS rn
          FROM mandatory_sidestakes
          WHERE block_height <= $h
        ) ranked
        WHERE rn = 1
      )
      SELECT
        cs.address                              AS address,
        cs.vout_idx                             AS vout_idx,
        cs.tx_id                                AS tx_id,
        CAST(cs.amount AS CHAR)                 AS amount,
        UNIX_TIMESTAMP(cs.time)                 AS time,
        coalesce(r.allocation_pct, 0.0)         AS allocation_pct,
        coalesce(r.description, '')             AS description,
        coalesce(r.status, '')                  AS status
      FROM coinstake_sidestakes AS cs
      LEFT JOIN registry r ON r.address = cs.address
      WHERE cs.block_height = $h
      ORDER BY cs.vout_idx
    `,
    { h: height },
  );
  res.status(StatusCodes.OK).send(withMeta({
    data: rows.map((r) => ({
      type: 'block_sidestake',
      id: `${height}:${r.vout_idx}`,
      attributes: {
        address: r.address,
        voutIdx: r.vout_idx,
        txId: r.tx_id,
        amount: halford2grc(BigInt(r.amount)),
        time: r.time,
        allocationPct: r.allocation_pct,
        description: r.description,
        // 'MANDATORY' if the recipient is in the active registry at
        // this height, '' if the recipient isn't registered (i.e.
        // the staker's local/voluntary sidestake to a non-protocol
        // address). The frontend uses this to badge MSS vs voluntary.
        registryStatus: r.status,
      },
    })),
  }));
});

// confirmed. Empty for any block ingested before MempoolWatcher
// started (deep-history blocks have no observation to draw from).
blocksRouter.get('/:height/mempool-snapshot', async (req: Request, res: Response) => {
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height', 'height must be an integer')],
    });
    return;
  }
  const rows = await query<SnapshotRow>(
    `
      SELECT
        block_hash,
        UNIX_TIMESTAMP(block_time)    AS block_time,
        UNIX_TIMESTAMP(captured_at)   AS captured_at,
        tx_id,
        UNIX_TIMESTAMP(first_seen)    AS first_seen,
        CAST(fee_estimate AS CHAR)    AS fee_estimate,
        size, vin_count, vout_count, was_included
      FROM mempool_snapshots
      WHERE block_height = $h
      ORDER BY first_seen ASC
    `,
    { h: height },
  );
  let totalFees = 0n;
  let totalSize = 0;
  let includedCount = 0;
  const txs = rows.map((r) => {
    const fee = BigInt(r.fee_estimate);
    totalFees += fee;
    totalSize += r.size;
    if (r.was_included) includedCount += 1;
    return {
      txId: r.tx_id,
      firstSeen: tsToUnix(r.first_seen) ?? 0,
      feeEstimate: halford2grc(fee),
      size: r.size,
      vinCount: r.vin_count,
      voutCount: r.vout_count,
      wasIncluded: Boolean(r.was_included),
    };
  });
  const first = rows[0];
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mempool_snapshot',
      id: String(height),
      attributes: {
        blockHeight: height,
        blockHash: first?.block_hash ?? null,
        blockTime: tsToUnix(first?.block_time),
        capturedAt: tsToUnix(first?.captured_at),
        count: txs.length,
        includedCount,
        totalFees: halford2grc(totalFees),
        totalSize,
        txs,
      },
    },
  }));
});
