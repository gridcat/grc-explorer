import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { halford2grc } from '../lib/halford';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { registerParamValidators } from '../lib/validators';

export const mandatorySidestakesRouter = Router();
registerParamValidators(mandatorySidestakesRouter);

// MSS registry + payout endpoints. Powers the home tile, the
// /mandatory-sidestakes page, and the per-address badge.
//
// "Active registry at H" = last row per address with block_height <= H
// AND status = 'MANDATORY'. We do that in CH via argMax(status,
// block_height) + filter rather than self-join — small table, cheap.
//
// `GET /` is on the home-page SSR fan-out and the underlying tables
// only change when a sidestake landing block lands (~570/day mainnet).
// 60s memo cache absorbs the home-page fan-out without staleness any
// human reader would notice.
const REGISTRY_TTL_MS = 60_000;
let registryCache: { body: unknown; expiresAt: number } | null = null;

interface ActiveRegistryRow {
  address: string;
  allocation_pct: number;
  description: string;
  tx_id: string;
  block_height: number;
  time: number;
  total_paid: string;
  payout_count: number;
}

/**
 * Current registry: every address that is currently in MANDATORY state.
 *
 * Joins payout aggregates from `coinstake_sidestakes` so the home UI
 * doesn't need a second round trip. `total_paid` is in halford as a
 * string; the presenter on the frontend converts to GRC for display.
 */
mandatorySidestakesRouter.get('/', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (registryCache && now < registryCache.expiresAt) {
    res.status(StatusCodes.OK).send(registryCache.body);
    return;
  }
  const result = await ch.query({
    query: `
      WITH latest AS (
        SELECT address,
               argMax(status, block_height)         AS status,
               argMax(allocation_pct, block_height) AS allocation_pct,
               argMax(description, block_height)    AS description,
               argMax(tx_id, block_height)          AS tx_id,
               -- NOT "AS block_height": that alias shadows the column
               -- and the argMax below then binds to this aggregate
               -- (ClickHouse error 184, aggregate-inside-aggregate).
               max(block_height)                    AS last_height,
               argMax(toUnixTimestamp(time), block_height) AS time
        FROM mandatory_sidestakes FINAL
        GROUP BY address
      )
      SELECT
        l.address                                  AS address,
        l.allocation_pct                           AS allocation_pct,
        l.description                              AS description,
        l.tx_id                                    AS tx_id,
        l.last_height                              AS block_height,
        l.time                                     AS time,
        toString(coalesce(p.total_paid, toUInt256(0))) AS total_paid,
        coalesce(p.payout_count, 0)                AS payout_count
      FROM latest l
      LEFT JOIN (
        SELECT address,
               toUInt256(sum(amount)) AS total_paid,
               count()                AS payout_count
        FROM coinstake_sidestakes FINAL
        GROUP BY address
      ) p ON p.address = l.address
      WHERE l.status = 'MANDATORY'
      ORDER BY l.allocation_pct DESC, l.address
    `,
    format: 'JSONEachRow',
  });
  const rows = await result.json<ActiveRegistryRow>();
  const body = withMeta({
    data: rows.map((r) => ({
      type: 'mandatory_sidestakes',
      id: r.address,
      attributes: {
        address: r.address,
        allocationPct: r.allocation_pct,
        description: r.description,
        registeredTxId: r.tx_id,
        registeredBlockHeight: r.block_height,
        registeredTime: r.time,
        totalPaid: halford2grc(BigInt(r.total_paid)),
        payoutCount: Number(r.payout_count),
      },
    })),
  });
  registryCache = { body, expiresAt: now + REGISTRY_TTL_MS };
  res.status(StatusCodes.OK).send(body);
});

/**
 * Per-address detail. Returns the registry lifecycle (every state
 * change for this destination) plus a paginated payout history.
 */
mandatorySidestakesRouter.get('/:address', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const [registryResult, payoutsResult, totalsResult] = await Promise.all([
    ch.query({
      query: `
        SELECT address, action, status, allocation_pct, description,
               tx_id, block_height, toUnixTimestamp(time) AS time
        FROM mandatory_sidestakes FINAL
        WHERE address = {addr: String}
        ORDER BY block_height
      `,
      query_params: { addr: address },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT block_height, vout_idx, tx_id,
               toString(amount)         AS amount,
               toUnixTimestamp(time)    AS time
        FROM coinstake_sidestakes FINAL
        WHERE address = {addr: String}
        ORDER BY block_height DESC, vout_idx
        LIMIT 200
      `,
      query_params: { addr: address },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT toString(toUInt256(sum(amount))) AS total,
               count()                          AS payout_count
        FROM coinstake_sidestakes FINAL
        WHERE address = {addr: String}
      `,
      query_params: { addr: address },
      format: 'JSONEachRow',
    }),
  ]);
  const registry = await registryResult.json<{
    address: string; action: string; status: string;
    allocation_pct: number; description: string;
    tx_id: string; block_height: number; time: number;
  }>();
  const payouts = await payoutsResult.json<{
    block_height: number; vout_idx: number; tx_id: string;
    amount: string; time: number;
  }>();
  const totalsRow = (await totalsResult.json<{ total: string; payout_count: number | string }>())[0]
    ?? { total: '0', payout_count: 0 };

  if (registry.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Sidestake recipient not found')],
    });
    return;
  }

  const last = registry[registry.length - 1];
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mandatory_sidestakes',
      id: address,
      attributes: {
        address,
        currentStatus: last.status,
        currentAllocationPct: last.allocation_pct,
        currentDescription: last.description,
        totalPaid: halford2grc(BigInt(totalsRow.total)),
        payoutCount: Number(totalsRow.payout_count),
        registry: registry.map((r) => ({
          action: r.action,
          status: r.status,
          allocationPct: r.allocation_pct,
          description: r.description,
          txId: r.tx_id,
          blockHeight: r.block_height,
          time: r.time,
        })),
        payouts: payouts.map((p) => ({
          blockHeight: p.block_height,
          voutIdx: p.vout_idx,
          txId: p.tx_id,
          amount: halford2grc(BigInt(p.amount)),
          time: p.time,
        })),
      },
    },
  }));
});
