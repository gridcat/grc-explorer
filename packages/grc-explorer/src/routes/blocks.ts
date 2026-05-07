import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
import { getCursor } from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { BlockPresenter } from '../presenters';

export const blocksRouter = Router();

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
}

// CH JSONEachRow returns DateTime as ISO string. Coerce to unix seconds
// to match the legacy Prisma shape the presenter+frontend expect.
function coerceTime(t: number | string): number {
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// Presenter expects mint/money_supply as bigint (matches the legacy
// Prisma row shape). CH JSONEachRow gives them as decimal strings —
// coerce here so halford2grc gets the bigint it expects.
function presentRow(r: BlockRow): Omit<BlockRow, 'mint' | 'money_supply'> & { mint: bigint; money_supply: bigint } {
  return {
    ...r,
    time: coerceTime(r.time),
    mint: BigInt(r.mint),
    money_supply: BigInt(r.money_supply),
  };
}

blocksRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const at = parseInt(String(req.query.at ?? ''), 10);
  const useAt = Number.isFinite(at) && at > 0;

  const baseQuery = useAt
    ? 'FROM blocks FINAL WHERE time <= toDateTime({at: UInt32})'
    : 'FROM blocks FINAL';
  const params = useAt ? { at } : {};

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `SELECT * ${baseQuery} ORDER BY height DESC LIMIT {limit: UInt32} OFFSET {offset: UInt32}`,
      query_params: { ...params, limit, offset },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c ${baseQuery}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowsResult.json<BlockRow>()).map(presentRow);
  const totalRows = await countResult.json<{ c: string | number }>();
  const total = Number(totalRows[0]?.c ?? 0);

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

  const txAttributes = txResult.map((t) => ({
    txId: t.tx_id,
    isCoinbase: t.is_coinbase,
    isCoinstake: t.is_coinstake,
    totalOut: halford2grc(BigInt(t.total_out)),
    fee: halford2grc(BigInt(t.fee)),
  }));

  const claim = claimResult[0] ?? null;
  const claimAttributes = claim
    ? {
      ...claim,
      block_subsidy: halford2grc(BigInt(claim.block_subsidy as string)),
      research_subsidy: halford2grc(BigInt(claim.research_subsidy as string)),
    }
    : null;

  const mrcAttributes = mrcResult.map((m) => ({
    cpid: m.cpid,
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
