import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { getTipAnchor } from '../lib/indexerTip';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { parseAt, resolveAtHeight } from '../lib/timeMachine';
import { BeaconPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const beaconsRouter = Router();
registerParamValidators(beaconsRouter);

interface BeaconRow {
  cpid: string;
  address: string;
  status: string;
  tx_id: string;
  block_height: number;
  timestamp: number | string;
  expiration: number | string;
  superseded_at_height: number | null;
}

function tsToUnix(t: number | string): number {
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function presentBeacon(b: BeaconRow): BeaconRow & { timestamp: number; expiration: number } {
  return {
    ...b,
    timestamp: tsToUnix(b.timestamp),
    expiration: tsToUnix(b.expiration),
  };
}

// Beacons list — paginated newest-first across every CPID. Accepts a
// `?status=active|expired|superseded|revoked` filter that's evaluated
// against `now` (or `?at=` if provided) so a stale `beacons.status`
// column doesn't show "active" rows whose expiration has actually
// passed.
beaconsRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const at = parseAt(req);
  const evalAt = at ?? await getTipAnchor();
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const statusFilter = String(req.query.status ?? '').trim().toLowerCase();

  const conditions: string[] = [];
  const params: Record<string, unknown> = { evalAt, limit, offset };
  if (atHeight !== null && at !== undefined) {
    conditions.push('block_height <= {atHeight: UInt32}');
    params.atHeight = atHeight;
  }
  if (statusFilter === 'revoked') {
    conditions.push("status = 'revoked'");
  } else if (statusFilter === 'active') {
    conditions.push("status != 'revoked'");
    conditions.push('expiration > toDateTime({evalAt: UInt32})');
    if (atHeight !== null) {
      conditions.push('(superseded_at_height IS NULL OR superseded_at_height > {atHeight: UInt32})');
    } else {
      conditions.push('superseded_at_height IS NULL');
    }
  } else if (statusFilter === 'expired') {
    conditions.push("status != 'revoked'");
    conditions.push('expiration <= toDateTime({evalAt: UInt32})');
  } else if (statusFilter === 'superseded') {
    conditions.push("status != 'revoked'");
    if (atHeight !== null) {
      conditions.push('superseded_at_height <= {atHeight: UInt32}');
    } else {
      conditions.push('superseded_at_height IS NOT NULL');
    }
  }
  const whereSql = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT cpid, address, status, tx_id, block_height,
               toUnixTimestamp(timestamp)  AS timestamp,
               toUnixTimestamp(expiration) AS expiration,
               superseded_at_height
        FROM beacons FINAL
        ${whereSql}
        ORDER BY block_height DESC, tx_id DESC
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c FROM beacons FINAL ${whereSql}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowsResult.json<BeaconRow>()).map(presentBeacon);
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);

  const enriched = rows.map((b) => {
    if (b.status === 'revoked') return b;
    if (atHeight !== null && b.superseded_at_height !== null && b.superseded_at_height <= atHeight) {
      return { ...b, status: 'superseded' };
    }
    if (atHeight === null && b.superseded_at_height !== null) {
      return { ...b, status: 'superseded' };
    }
    const live = b.expiration > evalAt;
    return { ...b, status: live ? 'active' : 'expired' };
  });
  const body = BeaconPresenter.render(enriched, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

beaconsRouter.get('/:cpid', async (req: Request, res: Response) => {
  const cpid = param(req, 'cpid');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const evalAt = at ?? await getTipAnchor();

  const result = await ch.query({
    query: atHeight !== null && at !== undefined
      ? `
        SELECT cpid, address, status, tx_id, block_height,
               toUnixTimestamp(timestamp)  AS timestamp,
               toUnixTimestamp(expiration) AS expiration,
               superseded_at_height
        FROM beacons FINAL
        WHERE cpid = {cpid: String} AND block_height <= {h: UInt32}
        ORDER BY block_height DESC
      `
      : `
        SELECT cpid, address, status, tx_id, block_height,
               toUnixTimestamp(timestamp)  AS timestamp,
               toUnixTimestamp(expiration) AS expiration,
               superseded_at_height
        FROM beacons FINAL
        WHERE cpid = {cpid: String}
        ORDER BY block_height DESC
      `,
    query_params: atHeight !== null && at !== undefined
      ? { cpid, h: atHeight }
      : { cpid },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<BeaconRow>()).map(presentBeacon);

  const enriched = rows.map((b) => {
    if (b.status === 'revoked') return b;
    if (atHeight !== null && b.superseded_at_height !== null && b.superseded_at_height <= atHeight) {
      return { ...b, status: 'superseded' };
    }
    const live = b.expiration > evalAt;
    return { ...b, status: live ? 'active' : 'expired' };
  });
  const body = BeaconPresenter.render(enriched, { meta: { count: rows.length } });
  res.status(StatusCodes.OK).send(withMeta(body));
});
