import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
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
  const rows = await query<ActiveRegistryRow>(
    `
      WITH latest AS (
        -- arg_max(col, block_height) per address = the latest row's
        -- columns; ROW_NUMBER picks that row (block_height DESC).
        SELECT address, status, allocation_pct, description, tx_id,
               block_height            AS last_height,
               UNIX_TIMESTAMP(time)    AS time
        FROM (
          SELECT address, status, allocation_pct, description, tx_id,
                 block_height, time,
                 ROW_NUMBER() OVER (PARTITION BY address ORDER BY block_height DESC) AS rn
          FROM mandatory_sidestakes
        ) ranked
        WHERE rn = 1
      )
      SELECT
        l.address                                  AS address,
        l.allocation_pct                           AS allocation_pct,
        l.description                              AS description,
        l.tx_id                                    AS tx_id,
        l.last_height                              AS block_height,
        l.time                                     AS time,
        CAST(coalesce(p.total_paid, 0) AS CHAR)    AS total_paid,
        coalesce(p.payout_count, 0)                AS payout_count
      FROM latest l
      LEFT JOIN (
        SELECT address,
               sum(amount) AS total_paid,
               count(*)    AS payout_count
        FROM coinstake_sidestakes
        GROUP BY address
      ) p ON p.address = l.address
      WHERE l.status = 'MANDATORY'
      ORDER BY l.allocation_pct DESC, l.address
    `,
  );
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

interface RegistryRow {
  address: string; action: string; status: string;
  allocation_pct: number; description: string;
  tx_id: string; block_height: number; time: number;
}

interface PayoutTotals { total: string; payout_count: number | string }

async function fetchRegistry(address: string): Promise<RegistryRow[]> {
  return query<RegistryRow>(
    `
      SELECT address, action, status, allocation_pct, description,
             tx_id, block_height, UNIX_TIMESTAMP(time) AS time
      FROM mandatory_sidestakes
      WHERE address = $addr
      ORDER BY block_height
    `,
    { addr: address },
  );
}

async function fetchPayoutTotals(address: string): Promise<PayoutTotals> {
  const rows = await query<PayoutTotals>(
    `
      SELECT CAST(coalesce(sum(amount), 0) AS CHAR) AS total,
             count(*)                               AS payout_count
      FROM coinstake_sidestakes
      WHERE address = $addr
    `,
    { addr: address },
  );
  return rows[0] ?? { total: '0', payout_count: 0 };
}

export interface SidestakeSummary {
  address: string;
  currentStatus: string;
  currentAllocationPct: number;
  currentDescription: string;
  totalPaid: string;
  payoutCount: number;
}

function summarise(address: string, registry: RegistryRow[], totals: PayoutTotals): SidestakeSummary {
  const last = registry[registry.length - 1];
  return {
    address,
    currentStatus: last.status,
    currentAllocationPct: last.allocation_pct,
    currentDescription: last.description,
    totalPaid: halford2grc(BigInt(totals.total)),
    payoutCount: Number(totals.payout_count),
  };
}

/**
 * Badge-sized view of an address's MSS standing, or null when it has
 * never been a registered recipient. That null is the steady state for
 * nearly every address, so the registry lookup runs alone first and the
 * payout aggregate only for actual recipients. Shared with the address
 * detail route's `include=sidestakes`.
 */
export async function fetchSidestakeSummary(address: string): Promise<SidestakeSummary | null> {
  const registry = await fetchRegistry(address);
  if (registry.length === 0) return null;
  return summarise(address, registry, await fetchPayoutTotals(address));
}

/**
 * Per-address detail. Returns the registry lifecycle (every state
 * change for this destination) plus a paginated payout history.
 * Registry first: a miss is a 404 after one small query, not three —
 * the address page asks this for every address it renders.
 */
mandatorySidestakesRouter.get('/:address', async (req: Request, res: Response) => {
  const address = param(req, 'address');
  const registry = await fetchRegistry(address);
  if (registry.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Sidestake recipient not found')],
    });
    return;
  }

  const [payouts, totals] = await Promise.all([
    query<{
      block_height: number; vout_idx: number; tx_id: string;
      amount: string; time: number;
    }>(
      `
        SELECT block_height, vout_idx, tx_id,
               CAST(amount AS CHAR)      AS amount,
               UNIX_TIMESTAMP(time)      AS time
        FROM coinstake_sidestakes
        WHERE address = $addr
        ORDER BY block_height DESC, vout_idx
        LIMIT 200
      `,
      { addr: address },
    ),
    fetchPayoutTotals(address),
  ]);

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'mandatory_sidestakes',
      id: address,
      attributes: {
        ...summarise(address, registry, totals),
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
