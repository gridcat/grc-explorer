import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { config } from '../config';
import { ch } from '../lib/ch';
import { getCursor } from '../lib/redis';
import { withMeta } from '../lib/responseMeta';
import { StatusPresenter } from '../presenters';
import packageJson from '../../package.json';

export const statusRouter = Router();

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

  const [tipResult, snapshotsResult] = await Promise.all([
    ch.query({
      query: 'SELECT height, hash, toUnixTimestamp(time) AS time FROM blocks FINAL ORDER BY height DESC LIMIT 1',
      format: 'JSONEachRow',
    }),
    // First block we have a mempool snapshot for. Mempool observations
    // can't be reconstructed from chain alone, so a re-ingest from
    // genesis won't backfill them — surfacing the cutoff lets clients
    // (the docs page, dashboards, integrators) tell users when the
    // /api/blocks/:height/mempool-snapshot view starts being useful.
    ch.query({
      query: 'SELECT min(block_height) AS h FROM mempool_snapshots',
      format: 'JSONEachRow',
    }),
  ]);
  const tipRows = await tipResult.json<{ height: number; hash: string; time: number }>();
  const tip = tipRows[0] ?? null;
  const snapRows = await snapshotsResult.json<{ h: number | null }>();
  const mempoolSnapshotsFromHeight = snapRows[0]?.h ?? null;

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
