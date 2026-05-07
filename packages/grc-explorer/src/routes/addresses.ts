import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { getPagination } from '../lib/pagination';
import {
  getRichList, getWallet, getWalletCount, WalletState,
} from '../lib/redis';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { parseAt, resolveAtHeight } from '../lib/timeMachine';
import { AddressPresenter } from '../presenters';

export const addressesRouter = Router();

// Presenter expects the legacy snake_case shape produced by the old
// MySQL `addresses` row. Map our Redis WalletState onto that shape.
function presentWallet(w: WalletState): {
  address: string; balance: bigint; total_received: bigint; total_sent: bigint;
  tx_count: number; first_seen_block: number | null; last_seen_block: number | null;
} {
  return {
    address: w.address,
    balance: w.balance,
    total_received: w.totalReceived,
    total_sent: w.totalSent,
    tx_count: w.txCount,
    first_seen_block: w.firstSeenBlock,
    last_seen_block: w.lastSeenBlock,
  };
}

// Rich list. Backed entirely by Redis: ZREVRANGE wallets:by_balance
// for the page slice + N×HGETALL for the row details. Sub-millisecond.
addressesRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const [wallets, total] = await Promise.all([
    getRichList(offset, limit),
    getWalletCount(),
  ]);
  const body = AddressPresenter.render(wallets.map(presentWallet), { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

addressesRouter.get('/:address', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);

  // Time-machine path: derive running totals from address_balance_history
  // by summing deltas at-or-before the requested chain-time → height.
  if (at !== undefined) {
    const atHeight = await resolveAtHeight(at);
    if (atHeight === null) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'No indexed blocks at that moment')],
      });
      return;
    }
    const histResult = await ch.query({
      query: `
        SELECT
          toString(sum(delta))    AS bal,
          toString(sum(received)) AS total_received,
          toString(sum(sent))     AS total_sent,
          sum(tx_count_delta)     AS tx_count,
          max(valid_from_height)  AS last_seen
        FROM address_balance_history FINAL
        WHERE address = {addr: String} AND valid_from_height <= {h: UInt32}
      `,
      query_params: { addr: address, h: atHeight },
      format: 'JSONEachRow',
    });
    const histRows = await histResult.json<{
      bal: string; total_received: string; total_sent: string;
      tx_count: number; last_seen: number;
    }>();
    if (histRows.length === 0 || histRows[0].last_seen === 0) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Address not seen at that moment')],
      });
      return;
    }
    const h = histRows[0];
    const synth = presentWallet({
      address,
      balance: BigInt(h.bal),
      totalReceived: BigInt(h.total_received),
      totalSent: BigInt(h.total_sent),
      txCount: Number(h.tx_count),
      firstSeenBlock: null,
      lastSeenBlock: h.last_seen,
    });
    const body = AddressPresenter.render(synth);
    res.status(StatusCodes.OK).send(withMeta(body, { pendingBalance: '0', at, atHeight }));
    return;
  }

  // Live path: HGETALL the wallet projection.
  const wallet = await getWallet(address);
  if (!wallet) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Address not found')],
    });
    return;
  }

  // Pending balance: sum of mempool tx outputs to this address.
  const pendingResult = await ch.query({
    query: `
      SELECT toString(sum(o.value)) AS pending
      FROM tx_outputs AS o FINAL
      WHERE o.address = {addr: String}
        AND o.tx_id IN (
          SELECT tx_id FROM mempool_txs FINAL
          WHERE confirmed_at IS NULL AND evicted_at IS NULL
        )
    `,
    query_params: { addr: address },
    format: 'JSONEachRow',
  });
  const pendingRows = await pendingResult.json<{ pending: string | null }>();
  const pendingSum = pendingRows[0]?.pending && pendingRows[0].pending !== '0'
    ? BigInt(pendingRows[0].pending)
    : null;
  const body = AddressPresenter.render(presentWallet(wallet));
  res.status(StatusCodes.OK).send(withMeta(body, {
    pendingBalance: pendingSum ? halford2grc(pendingSum) : '0',
  }));
});

addressesRouter.get('/:address/transactions', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const { offset, limit } = getPagination(req);

  const cap = atHeight !== null && at !== undefined
    ? 'AND block_height <= {h: UInt32}'
    : '';
  const query = `
    SELECT tx_id, max(block_height) AS height, max(time) AS ts, sum(delta) AS delta_sum
    FROM (
      SELECT tx_id, block_height,
             toUnixTimestamp(toDateTime(0)) AS time,
             toInt64(value) AS delta
      FROM tx_outputs FINAL
      WHERE address = {addr: String} ${cap}
      UNION ALL
      SELECT tx_id, block_height,
             toUnixTimestamp(toDateTime(0)) AS time,
             -toInt64(coalesce(value, 0)) AS delta
      FROM tx_inputs FINAL
      WHERE address = {addr: String} ${cap}
    ) AS movements
    GROUP BY tx_id
    ORDER BY height DESC, tx_id
    LIMIT {limit: UInt32} OFFSET {offset: UInt32}
  `;
  const params: Record<string, unknown> = { addr: address, limit, offset };
  if (atHeight !== null && at !== undefined) params.h = atHeight;
  const result = await ch.query({ query, query_params: params, format: 'JSONEachRow' });
  const rows = await result.json<{ tx_id: string; height: number; delta_sum: string }>();

  const txIds = rows.map((r) => r.tx_id);
  const timesByTx = new Map<string, number>();
  if (txIds.length > 0) {
    const tsResult = await ch.query({
      query: `
        SELECT tx_id, toUnixTimestamp(time) AS ts FROM transactions FINAL
        WHERE tx_id IN ({ids: Array(String)})
      `,
      query_params: { ids: txIds },
      format: 'JSONEachRow',
    });
    for (const r of await tsResult.json<{ tx_id: string; ts: number }>()) {
      timesByTx.set(r.tx_id, r.ts);
    }
  }

  const body = {
    data: rows.map((r) => ({
      type: 'address_tx',
      id: `${address}:${r.height}:${r.tx_id}`,
      attributes: {
        txId: r.tx_id,
        height: r.height,
        delta: halford2grc(BigInt(r.delta_sum)),
        ts: timesByTx.get(r.tx_id) ?? 0,
      },
    })),
    meta: { count: rows.length },
  };
  res.status(StatusCodes.OK).send(withMeta(body));
});

addressesRouter.get('/:address/utxos', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;

  const result = await ch.query({
    query: atHeight !== null && at !== undefined
      ? `
        SELECT o.tx_id AS tx_id, o.vout_n AS vout_n, toString(o.value) AS value,
               o.address AS address, o.script_type AS script_type, o.script_hex AS script_hex
        FROM tx_outputs AS o FINAL
        ANY LEFT JOIN tx_inputs AS i FINAL ON i.prev_tx = o.tx_id AND i.prev_vout = o.vout_n
        WHERE o.address = {addr: String}
          AND o.block_height <= {h: UInt32}
          AND (i.tx_id = '' OR i.block_height > {h: UInt32})
        ORDER BY o.tx_id, o.vout_n
      `
      : `
        SELECT o.tx_id AS tx_id, o.vout_n AS vout_n, toString(o.value) AS value,
               o.address AS address, o.script_type AS script_type, o.script_hex AS script_hex
        FROM tx_outputs AS o FINAL
        ANY LEFT JOIN tx_inputs AS i FINAL ON i.prev_tx = o.tx_id AND i.prev_vout = o.vout_n
        WHERE o.address = {addr: String} AND i.tx_id = ''
        ORDER BY o.tx_id, o.vout_n
      `,
    query_params: atHeight !== null && at !== undefined
      ? { addr: address, h: atHeight }
      : { addr: address },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    tx_id: string; vout_n: number; value: string; address: string;
    script_type: string; script_hex: string;
  }>();

  const body = {
    data: rows.map((r) => ({
      type: 'tx_outputs',
      id: `${r.tx_id}:${r.vout_n}`,
      attributes: {
        txId: r.tx_id,
        voutN: r.vout_n,
        value: halford2grc(BigInt(r.value)),
        address: r.address === '' ? null : r.address,
        scriptType: r.script_type,
        scriptHex: r.script_hex,
        isSpent: false,
      },
    })),
    meta: { count: rows.length },
  };
  res.status(StatusCodes.OK).send(withMeta(body));
});

addressesRouter.get('/:address/balance-history', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const now = Math.floor(Date.now() / 1000);
  const to = parseInt(String(req.query.to ?? ''), 10);
  const toTs = Number.isFinite(to) && to > 0 ? to : now;
  const from = parseInt(String(req.query.from ?? ''), 10);
  const fromTs = Number.isFinite(from) && from > 0 ? from : toTs - 30 * 86_400;
  const granularity = String(req.query.granularity ?? 'raw');

  // Running balance reconstructed on read via a window function.
  // address_balance_history stores per-block deltas only; the OVER
  // clause re-derives running_balance up to each row's height. Bounded
  // by the [from, to] window so we don't have to scan the full
  // address history every call.
  const result = await ch.query({
    query: `
      SELECT
        valid_from_height AS height,
        toUnixTimestamp(valid_from_time) AS ts,
        toString(running_balance) AS balance
      FROM (
        SELECT
          valid_from_height,
          valid_from_time,
          sum(delta) OVER (
            PARTITION BY address ORDER BY valid_from_height
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS running_balance
        FROM address_balance_history FINAL
        WHERE address = {addr: String}
      )
      WHERE valid_from_time >= toDateTime({from: UInt32})
        AND valid_from_time <= toDateTime({to: UInt32})
      ORDER BY valid_from_height ASC
    `,
    query_params: { addr: address, from: fromTs, to: toTs },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ height: number; ts: number; balance: string }>();

  type Point = { height: number; ts: number; balance: string };
  let points: Point[] = rows.map((r) => ({
    height: r.height,
    ts: r.ts,
    balance: halford2grc(BigInt(r.balance)),
  }));

  const bucketSec = ({ '1h': 3600, '1d': 86_400, '1w': 604_800 } as Record<string, number>)[granularity];
  if (bucketSec) {
    const byBucket = new Map<number, Point>();
    for (const p of points) {
      const key = Math.floor(p.ts / bucketSec) * bucketSec;
      byBucket.set(key, { ...p, ts: key });
    }
    points = Array.from(byBucket.values()).sort((a, b) => a.ts - b.ts);
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'address_balance_history',
      id: address,
      attributes: {
        address, from: fromTs, to: toTs, granularity, points,
      },
    },
  }));
});
