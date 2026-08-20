import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { hasColumns, query } from '../lib/db';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { ErrorModel } from '../lib/errors';
import { getTipAnchor } from '../lib/indexerTip';
import { log } from '../lib/log';
import { getPagination } from '../lib/pagination';
import { clampedQueryInt, param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { swrCachedLiveKeyed } from '../lib/swrCache';
import { SuperblockPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const superblocksRouter = Router();
registerParamValidators(superblocksRouter);

type StageTimings = Record<string, number>;

async function timed<T>(timings: StageTimings, stage: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    timings[stage] = Date.now() - started;
  }
}

function logRouteTiming(route: string, started: number, timings: StageTimings): void {
  const totalMs = Date.now() - started;
  if (totalMs < 250) return;
  const stages = Object.entries(timings).map(([name, ms]) => `${name}=${ms}ms`).join(' ');
  log.info(`[perf] ${route} total=${totalMs}ms ${stages}`);
}

// Active-beacon-count at a superblock height, evaluated as-of the
// superblock's block time. Immutable once the height is buried: every
// beacon with block_height <= H already exists, expiration is tested
// against the fixed block time, and a supersession after H does not
// remove the beacon from the as-of-H view. Backed by
// idx_beacons_active_count (migration 0013) so the scan is index-only
// rather than one random HDD row lookup per in-range beacon.
async function computeActiveBeaconCount(height: number, evalAt: number): Promise<number> {
  const rows = await query<{ c: string | number }>(
    `
      SELECT count(*) AS c FROM beacons
      WHERE block_height <= $h
        AND timestamp <= FROM_UNIXTIME($eval)
        AND expiration > FROM_UNIXTIME($eval)
        AND status != 'revoked'
        AND (superseded_at_height IS NULL OR superseded_at_height > $h)
    `,
    { h: height, eval: evalAt },
  );
  return Number(rows[0]?.c ?? 0);
}

// Keyed by height (bypassed entirely while the indexer is backfilling —
// swrCachedLiveKeyed — so a half-built chain can't poison it). A short
// memo, not permanent: only the tip-ward superblock's count can still
// drift as new beacons land, and the count is a cosmetic header stat.
const activeBeaconCountCache = swrCachedLiveKeyed<number>(30 * 60_000);

// Only the canonical block-time path (blockTime !== null) is cached.
// BlockWriter inserts the superblock row and the same-height block row
// in separate statements, so this route can briefly see the superblock
// before its block — then blockTime is null, evalAt falls back to the
// live tip anchor, and caching THAT by height would pin a wrong value
// for the full TTL. In that window we compute fresh and skip the cache.
function activeBeaconCountAtHeight(
  height: number,
  evalAt: number,
  cacheable: boolean,
): Promise<number> {
  if (!cacheable) return computeActiveBeaconCount(height, evalAt);
  return activeBeaconCountCache(String(height), () => computeActiveBeaconCount(height, evalAt));
}

interface SuperblockRow {
  height: number;
  quorum_hash: string;
  total_magnitude: number;
  cpid_count: number;
  project_count: number;
  payload_size: number;
  contract_version?: number;
}

const hasContractVersionColumn = () => hasColumns('superblocks', ['contract_version']);

// GET /superblocks/timeline
//   Capped sample of superblock metrics over the chain, height-asc.
//   Down-sampled CH-side via `intDiv(rowNumber, stride)` so the wire
//   payload stays bounded regardless of chain age — 500 points is more
//   than recharts can paint usefully at 100% column width, and keeps
//   the JSON under ~30 KB even on a long mainnet. The endpoints the
//   tip and (height-0) are always included so the chart spans the
//   actual indexed range.
const TIMELINE_MAX_POINTS = 500;
superblocksRouter.get('/timeline', async (_req: Request, res: Response) => {
  const rows = await query<{
    height: number; project_count: number; cpid_count: number; total_magnitude: number;
  }>(
    `
      WITH agg AS (SELECT count(*) AS total FROM superblocks),
      numbered AS (
        SELECT height, project_count, cpid_count, total_magnitude,
               row_number() OVER (ORDER BY height ASC) AS rn,
               max(height) OVER () AS max_h
        FROM superblocks
      )
      SELECT height, project_count, cpid_count, total_magnitude
      FROM numbered, agg
      WHERE (rn - 1) % GREATEST(agg.total DIV $cap, 1) = 0 OR height = max_h
      ORDER BY height ASC
    `,
    { cap: TIMELINE_MAX_POINTS },
  );
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'superblock_timeline',
      id: 'all',
      attributes: {
        samples: rows.map((r) => ({
          height: r.height,
          projectCount: r.project_count,
          cpidCount: r.cpid_count,
          totalMagnitude: r.total_magnitude,
        })),
      },
    },
  }));
});

superblocksRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const versionSelect = (await hasContractVersionColumn()) ? ', contract_version' : '';
  const [rows, countRows] = await Promise.all([
    query<SuperblockRow>(
      `
        SELECT height, quorum_hash, total_magnitude, cpid_count, project_count, payload_size
               ${versionSelect}
        FROM superblocks
        ORDER BY height DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `,
    ),
    query<{ c: string | number }>('SELECT count(*) AS c FROM superblocks'),
  ]);
  const total = Number(countRows[0]?.c ?? 0);
  const body = SuperblockPresenter.render(rows, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

superblocksRouter.get('/:height', async (req: Request, res: Response) => {
  const requestStarted = Date.now();
  const timings: StageTimings = {};
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height')],
    });
    return;
  }
  const magnitudeLimit = req.query.magnitudesLimit === undefined
    ? null
    : clampedQueryInt(req, 'magnitudesLimit', { def: 200, min: 1, max: 5000 });
  const includeActiveBeaconCount = String(req.query.includeActiveBeaconCount ?? 'true') !== 'false';
  const sbRows = await timed(timings, 'superblock', () => query<SuperblockRow>(
    'SELECT * FROM superblocks WHERE height = $h LIMIT 1', { h: height },
  ));
  );
  if (sbRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Superblock not found')],
    });
    return;
  }
  const row = sbRows[0];

  const blockRows = await timed(timings, 'block', () => query<{ time: number }>(
    'SELECT UNIX_TIMESTAMP(time) AS time FROM blocks WHERE height = $h LIMIT 1',
    { h: height },
  ));
  const blockTime = blockRows[0]?.time ?? null;
  const evalAt = blockTime ?? await getTipAnchor();

  const [rawMagnitudes, projects, activeBeaconCount] = await Promise.all([
    // (cpid, superblock_height) is the PK, so each cpid appears once for
    // this superblock — no dedup needed.
    timed(timings, 'magnitudes', () => query<{ cpid: string; magnitude: number }>(
      `
        SELECT cpid, magnitude
        FROM superblock_magnitudes
        WHERE superblock_height = $h
        ORDER BY magnitude DESC
        ${magnitudeLimit === null ? '' : `LIMIT ${Number(magnitudeLimit)}`}
      `,
      { h: height },
    )),
    timed(timings, 'projects', () => query<{
      project_name: string; average_rac: number; rac: number; total_credit: number;
    }>(
      `
        SELECT project_name, average_rac, rac, total_credit
        FROM superblock_projects
        WHERE superblock_height = $h
        ORDER BY rac DESC
      `,
      { h: height },
    )),
    includeActiveBeaconCount
      ? timed(timings, 'activeBeacons', () => activeBeaconCountAtHeight(height, evalAt, blockTime !== null))
      : Promise.resolve(null),
  ]);
  // Server-side names so the superblock-detail SSR seed (can be ~900
  // CPIDs) renders without fanning out parallel /cpids/names calls.
  const magNames = await timed(
    timings,
    'cpidNames',
    () => resolveCpidNames(rawMagnitudes.map((m) => m.cpid)),
  );
  const magnitudes = rawMagnitudes.map((m) => ({
    ...m,
    displayName: cpidDisplayName(magNames, m.cpid),
  }));

  const body = SuperblockPresenter.render(row);
  const sendStarted = Date.now();
  res.status(StatusCodes.OK).send(withMeta(body, {
    blockTime,
    activeBeaconCount,
    magnitudeTotal: Number(row.cpid_count ?? rawMagnitudes.length),
    magnitudes,
    projects: projects.map((p) => ({
      projectName: p.project_name,
      averageRac: p.average_rac,
      rac: p.rac,
      totalCredit: p.total_credit,
    })),
  }));
  timings.serialize = Date.now() - sendStarted;
  logRouteTiming(`GET /superblocks/${height}`, requestStarted, timings);
});

// Paginated magnitude rows for progressive disclosure on the detail page.
// The legacy detail endpoint still returns every row unless its caller opts
// into magnitudesLimit, preserving the public API contract.
superblocksRouter.get('/:height/magnitudes', async (req: Request, res: Response) => {
  const requestStarted = Date.now();
  const timings: StageTimings = {};
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height')],
    });
    return;
  }
  const limit = clampedQueryInt(req, 'limit', { def: 200, min: 1, max: 500 });
  const offset = clampedQueryInt(req, 'offset', { def: 0, min: 0, max: 100_000 });
  const sbRows = await timed(timings, 'superblock', () => query<{ cpid_count: number }>(
    'SELECT cpid_count FROM superblocks WHERE height = $h LIMIT 1', { h: height },
  ));
  if (sbRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Superblock not found')],
    });
    return;
  }
  const rows = await timed(timings, 'magnitudes', () => query<{ cpid: string; magnitude: number }>(
    `SELECT cpid, magnitude
     FROM superblock_magnitudes
     WHERE superblock_height = $h
     ORDER BY magnitude DESC
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    { h: height },
  ));
  const names = await timed(timings, 'cpidNames', () => resolveCpidNames(rows.map((r) => r.cpid)));
  const magnitudes = rows.map((row) => ({
    ...row,
    displayName: cpidDisplayName(names, row.cpid),
  }));
  const sendStarted = Date.now();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'superblock_magnitudes',
      id: `${height}:${offset}`,
      attributes: {
        height,
        total: Number(sbRows[0].cpid_count ?? 0),
        offset,
        limit,
        magnitudes,
      },
    },
  }));
  timings.serialize = Date.now() - sendStarted;
  logRouteTiming(`GET /superblocks/${height}/magnitudes`, requestStarted, timings);
});

// The active-beacon count is useful context but not required to render the
// detail page. Load it independently so a cold historical count cannot hold
// the whole SSR response hostage.
superblocksRouter.get('/:height/active-beacon-count', async (req: Request, res: Response) => {
  const requestStarted = Date.now();
  const timings: StageTimings = {};
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height')],
    });
    return;
  }
  const blockRows = await timed(timings, 'block', () => query<{ time: number }>(
    'SELECT UNIX_TIMESTAMP(time) AS time FROM blocks WHERE height = $h LIMIT 1', { h: height },
  ));
  const blockTime = blockRows[0]?.time ?? null;
  const evalAt = blockTime ?? await timed(timings, 'tipAnchor', () => getTipAnchor());
  const count = await timed(
    timings,
    'activeBeacons',
    () => activeBeaconCountAtHeight(height, evalAt, blockTime !== null),
  );
  const sendStarted = Date.now();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'superblock_active_beacon_count',
      id: String(height),
      attributes: { height, count },
    },
  }));
  timings.serialize = Date.now() - sendStarted;
  logRouteTiming(`GET /superblocks/${height}/active-beacon-count`, requestStarted, timings);
});
