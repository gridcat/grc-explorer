import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch, hasColumns } from '../lib/ch';
import { getTipAnchor, getV11BlockTimestamp } from '../lib/indexerTip';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { parseAt, resolveAtHeight } from '../lib/timeMachine';
import { BeaconPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';
import { BEACON_RENEWAL_AGE_SEC } from '../services/indexer/ContractParser';
import { tsToUnix } from '../lib/time';

const hasAuthMethodColumn = () => hasColumns('beacons', ['auth_method']);

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
  auth_method?: string;
}

function presentBeacon(b: BeaconRow): BeaconRow & { timestamp: number; expiration: number } {
  return {
    ...b,
    timestamp: tsToUnix(b.timestamp) ?? 0,
    expiration: tsToUnix(b.expiration) ?? 0,
  };
}

/**
 * Derive the two renewal-state fields the UI needs from a presented row.
 *
 * `renewable_until` = expiration timestamp once the beacon is past its
 * `RENEWAL_AGE` window AND still active. Null otherwise (pre-renewal,
 * already expired, revoked, superseded).
 *
 * `must_readvertise` = true for pre-v11 beacons (timestamp <= the
 * v11-boundary block-time). The wallet rejects renewal contracts that
 * reference such beacons (`beacon.cpp:~869`) — they must be entirely
 * re-advertised, not renewed.
 */
function deriveRenewalState(
  b: BeaconRow & { timestamp: number; expiration: number },
  evalAt: number,
  v11Timestamp: number | null,
  effectiveStatus: string,
): { renewable_until: number | null; must_readvertise: boolean } {
  const mustReadvertise = v11Timestamp !== null && b.timestamp <= v11Timestamp;
  if (effectiveStatus !== 'active') {
    return { renewable_until: null, must_readvertise: mustReadvertise };
  }
  const renewalFrom = b.timestamp + BEACON_RENEWAL_AGE_SEC;
  if (evalAt < renewalFrom || mustReadvertise) {
    return { renewable_until: null, must_readvertise: mustReadvertise };
  }
  return { renewable_until: b.expiration, must_readvertise: false };
}

/**
 * Resolve a beacon row's effective status at `evalAt` / `atHeight`.
 *
 * Stored `beacons.status` is whatever the parser wrote at ingest time;
 * superseded/expired are derived states that must be evaluated against
 * the current (or time-travelled) view of the chain. `revoked` is
 * terminal — that row stays revoked forever regardless of when you ask.
 */
function deriveEffectiveStatus(
  b: BeaconRow & { timestamp: number; expiration: number },
  atHeight: number | null,
  evalAt: number,
): string {
  if (b.status === 'revoked') return 'revoked';
  const supersededInWindow = atHeight !== null
    ? (b.superseded_at_height !== null && b.superseded_at_height <= atHeight)
    : (b.superseded_at_height !== null);
  if (supersededInWindow) return 'superseded';
  return b.expiration > evalAt ? 'active' : 'expired';
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
  const hasAuth = await hasAuthMethodColumn();
  const authSelect = hasAuth ? ', auth_method' : '';

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT cpid, address, status, tx_id, block_height,
               toUnixTimestamp(timestamp)  AS timestamp,
               toUnixTimestamp(expiration) AS expiration,
               superseded_at_height
               ${authSelect}
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
  const v11Timestamp = await getV11BlockTimestamp();

  const enriched = rows.map((b) => {
    const status = deriveEffectiveStatus(b, atHeight, evalAt);
    return { ...b, status, ...deriveRenewalState(b, evalAt, v11Timestamp, status) };
  });
  const body = BeaconPresenter.render(enriched, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

beaconsRouter.get('/:cpid', async (req: Request, res: Response) => {
  const cpid = param(req, 'cpid');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const evalAt = at ?? await getTipAnchor();

  // Single SELECT shape with conditional WHERE — only the time-travel
  // case adds the `block_height <= {h}` clause. Mirrors the list
  // handler's `conditions[]` pattern so the two routes stay aligned.
  const whereParts = ['cpid = {cpid: String}'];
  const params: Record<string, unknown> = { cpid };
  if (atHeight !== null && at !== undefined) {
    whereParts.push('block_height <= {h: UInt32}');
    params.h = atHeight;
  }
  const authSelect = (await hasAuthMethodColumn()) ? ', auth_method' : '';
  const result = await ch.query({
    query: `
      SELECT cpid, address, status, tx_id, block_height,
             toUnixTimestamp(timestamp)  AS timestamp,
             toUnixTimestamp(expiration) AS expiration,
             superseded_at_height
             ${authSelect}
      FROM beacons FINAL
      WHERE ${whereParts.join(' AND ')}
      ORDER BY block_height DESC
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = (await result.json<BeaconRow>()).map(presentBeacon);
  const v11Timestamp = await getV11BlockTimestamp();

  const enriched = rows.map((b) => {
    const status = deriveEffectiveStatus(b, atHeight, evalAt);
    return { ...b, status, ...deriveRenewalState(b, evalAt, v11Timestamp, status) };
  });
  const body = BeaconPresenter.render(enriched, { meta: { count: rows.length } });
  res.status(StatusCodes.OK).send(withMeta(body));
});
