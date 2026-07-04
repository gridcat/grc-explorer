import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { hasColumns, query } from '../lib/db';
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

  // Build params to include ONLY what the WHERE actually references —
  // DuckDB errors on a bound param the SQL doesn't use.
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (atHeight !== null && at !== undefined) {
    conditions.push('block_height <= $atHeight');
    params.atHeight = atHeight;
  }
  if (statusFilter === 'revoked') {
    conditions.push("status = 'revoked'");
  } else if (statusFilter === 'active') {
    conditions.push("status != 'revoked'");
    conditions.push('expiration > FROM_UNIXTIME($evalAt)');
    params.evalAt = evalAt;
    if (atHeight !== null) {
      conditions.push('(superseded_at_height IS NULL OR superseded_at_height > $atHeight)');
    } else {
      conditions.push('superseded_at_height IS NULL');
    }
  } else if (statusFilter === 'expired') {
    conditions.push("status != 'revoked'");
    conditions.push('expiration <= FROM_UNIXTIME($evalAt)');
    params.evalAt = evalAt;
  } else if (statusFilter === 'superseded') {
    conditions.push("status != 'revoked'");
    if (atHeight !== null) {
      conditions.push('superseded_at_height <= $atHeight');
    } else {
      conditions.push('superseded_at_height IS NOT NULL');
    }
  }
  const whereSql = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const hasAuth = await hasAuthMethodColumn();
  const authSelect = hasAuth ? ', auth_method' : '';

  // Two-phase page fetch: resolve the page's PKs with a query covered
  // by idx_beacons_height_tx (backward prefix scan matches the ORDER
  // BY — 25 entries, no sort, no cold full-table read), then fetch the
  // full rows by PK and restore the order in JS. A single uncovered
  // ORDER BY query won't use the index (the planner prices a row
  // lookup per index ENTRY, ignoring the LIMIT — same story as the
  // rich list). Status filters reference non-indexed columns, so
  // phase 1 degrades to the previous scan shape for them; the
  // unfiltered default page is the one that must stay cheap.
  const [pageKeys, countRows] = await Promise.all([
    query<{ cpid: string; block_height: number; tx_id: string }>(
      `
        SELECT cpid, block_height, tx_id
        FROM beacons
        ${whereSql}
        ORDER BY block_height DESC, tx_id DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `,
      params,
    ),
    query<{ c: string | number }>(
      `SELECT count(*) AS c FROM beacons ${whereSql}`,
      params,
    ),
  ]);
  let rawRows: BeaconRow[] = [];
  if (pageKeys.length > 0) {
    const order = new Map<string, number>();
    const values: unknown[] = [];
    const tuples: string[] = [];
    pageKeys.forEach((k, i) => {
      order.set(`${k.cpid}:${k.block_height}:${k.tx_id}`, i);
      const base = values.length;
      values.push(k.cpid, k.block_height, k.tx_id);
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    });
    rawRows = await query<BeaconRow>(
      `
        SELECT cpid, address, status, tx_id, block_height,
               UNIX_TIMESTAMP(timestamp)  AS timestamp,
               UNIX_TIMESTAMP(expiration) AS expiration,
               superseded_at_height
               ${authSelect}
        FROM beacons
        WHERE (cpid, block_height, tx_id) IN (${tuples.join(', ')})
      `,
      values,
    );
    rawRows.sort((a, b) => (order.get(`${a.cpid}:${a.block_height}:${a.tx_id}`) ?? 0)
      - (order.get(`${b.cpid}:${b.block_height}:${b.tx_id}`) ?? 0));
  }
  const rows = rawRows.map(presentBeacon);
  const total = Number(countRows[0]?.c ?? 0);
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
  const whereParts = ['cpid = $cpid'];
  const params: Record<string, unknown> = { cpid };
  if (atHeight !== null && at !== undefined) {
    whereParts.push('block_height <= $h');
    params.h = atHeight;
  }
  const authSelect = (await hasAuthMethodColumn()) ? ', auth_method' : '';
  const rows = (await query<BeaconRow>(
    `
      SELECT cpid, address, status, tx_id, block_height,
             UNIX_TIMESTAMP(timestamp)  AS timestamp,
             UNIX_TIMESTAMP(expiration) AS expiration,
             superseded_at_height
             ${authSelect}
      FROM beacons
      WHERE ${whereParts.join(' AND ')}
      ORDER BY block_height DESC
    `,
    params,
  )).map(presentBeacon);
  const v11Timestamp = await getV11BlockTimestamp();

  const enriched = rows.map((b) => {
    const status = deriveEffectiveStatus(b, atHeight, evalAt);
    return { ...b, status, ...deriveRenewalState(b, evalAt, v11Timestamp, status) };
  });
  const body = BeaconPresenter.render(enriched, { meta: { count: rows.length } });
  res.status(StatusCodes.OK).send(withMeta(body));
});
