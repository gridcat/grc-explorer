import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { config } from '../config';
import { query } from '../lib/db';
import { getCursor } from '../lib/redis';
import { withMeta } from '../lib/responseMeta';
import { StatusPresenter } from '../presenters';
import packageJson from '../../package.json';

export const statusRouter = Router();

// `min(block_height)` over mempool_snapshots is monotone-increasing
// and changes only when the watcher first runs against a fresh DB —
// safe to cache aggressively. /status is polled by the live dashboard
// every 30s; this drops one CH round trip per poll.
let snapshotsFromHeightCache: { value: number | null; expiresAt: number } | null = null;
const SNAPSHOTS_TTL_MS = 60_000;
async function getMempoolSnapshotsFromHeight(): Promise<number | null> {
  const now = Date.now();
  if (snapshotsFromHeightCache && now < snapshotsFromHeightCache.expiresAt) {
    return snapshotsFromHeightCache.value;
  }
  const rows = await query<{ h: number | null }>(
    'SELECT min(block_height) AS h FROM mempool_snapshots',
  );
  const value = rows[0]?.h ?? null;
  snapshotsFromHeightCache = { value, expiresAt: now + SNAPSHOTS_TTL_MS };
  return value;
}

statusRouter.get('/', async (_req: Request, res: Response) => {
  const cursor = await getCursor();
  // Indexer state shape preserved for the frontend's sake. The legacy
  // MySQL `indexer_state` row had `last_indexed_height/hash/status` —
  // map our Redis cursor onto the same field names.
  const indexerState = cursor
    ? {
      id: 1,
      last_indexed_height: cursor.height,
      last_indexed_hash: cursor.hash,
      status: cursor.status,
      reorg_depth: 0,
      polls_rescan_height: 0,
      updated_at: new Date(cursor.updatedAt),
    }
    : null;

  // First block we have a mempool snapshot for. Mempool observations
  // can't be reconstructed from chain alone, so a re-ingest from
  // genesis won't backfill them — surfacing the cutoff lets clients
  // (docs page, dashboards, integrators) tell users when the
  // /api/blocks/:height/mempool-snapshot view starts being useful.
  const [tipRows, mempoolSnapshotsFromHeight] = await Promise.all([
    query<{ height: number; hash: string; time: number }>(
      'SELECT height, hash, CAST(epoch(time) AS UINTEGER) AS time FROM blocks ORDER BY height DESC LIMIT 1',
    ),
    getMempoolSnapshotsFromHeight(),
  ]);
  const tip = tipRows[0] ?? null;

  const body = StatusPresenter.render({
    name: packageJson.name,
    version: packageJson.version,
    network: config.NETWORK,
    indexerState,
    tip,
    mempoolSnapshotsFromHeight,
  });
  res.status(StatusCodes.OK).send(withMeta(body));
});
