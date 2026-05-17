import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
import { getCursor } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { tsToUnix } from '../lib/time';
import { BlockPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

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
// Prisma row shape). CH JSONEachRow gives them as decimal strings —
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

  // The list bounds claims to the page's heights (claims is sort-keyed
  // by block_height); the count and the deduped blocks-tail subqueries
  // share this unaliased time predicate (no `b.` alias inside them).
  const countTimeFilter = useAt ? 'WHERE time <= toDateTime({at: UInt32})' : '';
  const params = useAt ? { at } : {};

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      // The previous form put `LIMIT 1 BY height` over `SELECT *` of
      // the WHOLE blocks table before the outer LIMIT — a stateful
      // dedup with no short-circuit, so a 25-row page read ~7.3M rows
      // / 1.09 GiB (measured). Fix: resolve the page's heights from
      // the `height` column alone first (height is the sort key, so
      // `ORDER BY height DESC LIMIT/OFFSET` reads the tail; the time
      // filter rides idx_blocks_time) — that's a few KB. Then fetch
      // and per-_seq-dedup only those ≤limit heights via the PK, and
      // bound the claims join the same way. Byte-identical result.
      query: `
        WITH page_heights AS (
          SELECT height
          FROM blocks
          ${countTimeFilter}
          GROUP BY height
          ORDER BY height DESC
          LIMIT {limit: UInt32} OFFSET {offset: UInt32}
        )
        SELECT b.*, c.is_mrc AS is_mrc
        FROM (
          SELECT * FROM blocks
          WHERE height IN (SELECT height FROM page_heights)
          ORDER BY height DESC, _seq DESC
          LIMIT 1 BY height
        ) AS b
        ANY LEFT JOIN (
          SELECT block_height, is_mrc
          FROM claims
          WHERE block_height IN (SELECT height FROM page_heights)
          ORDER BY _seq DESC
          LIMIT 1 BY block_height
        ) AS c ON c.block_height = b.height
        ORDER BY b.height DESC
      `,
      query_params: { ...params, limit, offset },
      format: 'JSONEachRow',
    }),
    ch.query({
      // Heights are contiguous genesis→tip (HistoricalBackfiller
      // commits strictly in order — no gaps even mid-backfill), so the
      // listable block count is exactly max-min+1. min()/max() over the
      // `height` sort key resolve from per-part min/max metadata: no row
      // scan. The previous `count() … GROUP BY height` aggregated the
      // whole height column (~millions of rows) on every page load.
      // For the `at` path the predicate still prunes via
      // idx_blocks_time. Empty/clamped result → NULL, handled JS-side.
      query: `SELECT toUInt64(max(height) - min(height) + 1) AS c FROM blocks ${countTimeFilter}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rawRows = await rowsResult.json<BlockRow>();
  const totalRows = await countResult.json<{ c: string | number }>();
  const total = Number(totalRows[0]?.c ?? 0);

  // Per-block user activity: sum(total_out) + sum(fee) for non-coinbase
  // non-coinstake txs. Cheap because `transactions` is sort-keyed by
  // (block_height, index_in_blk) so the IN-list lookup is a multi-
  // range sorted scan over the page's blocks. Aggregates surface as
  // `valueMoved` / `feeTotal` on each row alongside `mint` (block
  // reward) so consumers can distinguish "what users moved" from
  // "what the block emitted".
  // Both the per-block value/fee aggregate and the staker-name
  // resolution depend only on rawRows, so run them concurrently —
  // saves one CH round trip on the SSR path (they used to await in
  // series). Staker display names are resolved server-side so the SSR
  // seed (home LiveBlockTicker, /blocks page) renders names without a
  // second /cpids/names round trip.
  type AggRow = { block_height: number; value_moved: string; fee_total: string };
  const heights = rawRows.map((r) => r.height);
  const [aggRows, stakerNames] = await Promise.all([
    heights.length > 0
      ? ch.query({
        query: `
          SELECT
            block_height,
            toString(sum(total_out)) AS value_moved,
            toString(sum(fee))       AS fee_total
          FROM transactions FINAL
          WHERE block_height IN ({heights: Array(UInt32)})
            AND NOT is_coinbase AND NOT is_coinstake
          GROUP BY block_height
        `,
        query_params: { heights },
        format: 'JSONEachRow',
      }).then((r) => r.json<AggRow>())
      : Promise.resolve([] as AggRow[]),
    resolveCpidNames(rawRows.map((r) => r.staker_cpid).filter((c): c is string => !!c)),
  ]);
  const aggMap = new Map<number, { value_moved: string; fee_total: string }>();
  for (const a of aggRows) {
    aggMap.set(a.block_height, { value_moved: a.value_moved, fee_total: a.fee_total });
  }
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

blocksRouter.get('/:height', async (req: Request, res: Response) => {
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height', 'height must be an integer')],
    });
    return;
  }
  const blockResult = await ch.query({
    query: 'SELECT * FROM blocks FINAL WHERE height = {h: UInt32} LIMIT 1',
    query_params: { h: height },
    format: 'JSONEachRow',
  });
  const blockRows = await blockResult.json<BlockRow>();
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
      ? ch.query({
        query: `
          SELECT tx_id, is_coinbase, is_coinstake, total_out, fee, index_in_blk
          FROM transactions FINAL
          WHERE block_height = {h: UInt32}
          ORDER BY index_in_blk ASC
        `,
        query_params: { h: height },
        format: 'JSONEachRow',
      }).then((r) => r.json<{
        tx_id: string; is_coinbase: boolean; is_coinstake: boolean;
        total_out: string; fee: string; index_in_blk: number;
      }>())
      : Promise.resolve([]),
    ch.query({
      query: 'SELECT * FROM claims FINAL WHERE block_height = {h: UInt32} LIMIT 1',
      query_params: { h: height },
      format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>()),
    ch.query({
      query: `
        SELECT cpid, mining_id, client_version, research_subsidy, magnitude, pay_to_address
        FROM claim_mrcs FINAL
        WHERE block_height = {h: UInt32}
        ORDER BY toUInt64(research_subsidy) DESC
      `,
      query_params: { h: height },
      format: 'JSONEachRow',
    }).then((r) => r.json<{
      cpid: string; mining_id: string; client_version: string;
      research_subsidy: string; magnitude: number; pay_to_address: string | null;
    }>()),
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

  const body = BlockPresenter.render(row);
  res.status(StatusCodes.OK).send(withMeta(body, {
    transactions: txAttributes,
    claim: claimAttributes,
    mrcs: mrcAttributes,
    tipHeight: cursor?.height ?? row.height,
  }));
});

blocksRouter.get('/hash/:hash', async (req: Request, res: Response) => {
  const result = await ch.query({
    query: 'SELECT height FROM blocks FINAL WHERE hash = {hash: String} LIMIT 1',
    query_params: { hash: param(req, 'hash') },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ height: number }>();
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
  const result = await ch.query({
    query: `
      WITH registry AS (
        SELECT address,
               argMax(status, block_height)         AS status,
               argMax(allocation_pct, block_height) AS allocation_pct,
               argMax(description, block_height)    AS description
        FROM mandatory_sidestakes FINAL
        WHERE block_height <= {h: UInt32}
        GROUP BY address
      )
      SELECT
        cs.address                              AS address,
        cs.vout_idx                             AS vout_idx,
        cs.tx_id                                AS tx_id,
        toString(cs.amount)                     AS amount,
        toUnixTimestamp(cs.time)                AS time,
        coalesce(r.allocation_pct, 0.0)         AS allocation_pct,
        coalesce(r.description, '')             AS description,
        coalesce(r.status, '')                  AS status
      FROM coinstake_sidestakes AS cs FINAL
      LEFT JOIN registry r ON r.address = cs.address
      WHERE cs.block_height = {h: UInt32}
      ORDER BY cs.vout_idx
    `,
    query_params: { h: height },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    address: string; vout_idx: number; tx_id: string;
    amount: string; time: number;
    allocation_pct: number; description: string; status: string;
  }>();
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
  const result = await ch.query({
    query: `
      SELECT
        block_hash,
        toUnixTimestamp(block_time)   AS block_time,
        toUnixTimestamp(captured_at)  AS captured_at,
        tx_id,
        toUnixTimestamp(first_seen)   AS first_seen,
        toString(fee_estimate)        AS fee_estimate,
        size, vin_count, vout_count, was_included
      FROM mempool_snapshots FINAL
      WHERE block_height = {h: UInt32}
      ORDER BY first_seen ASC
    `,
    query_params: { h: height },
    format: 'JSONEachRow',
  });
  const rows = await result.json<SnapshotRow>();
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
