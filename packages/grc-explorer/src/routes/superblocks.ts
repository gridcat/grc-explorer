import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { SuperblockPresenter } from '../presenters';

export const superblocksRouter = Router();

interface SuperblockRow {
  height: number;
  quorum_hash: string;
  total_magnitude: number;
  cpid_count: number;
  project_count: number;
  payload_size: number;
}

superblocksRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT height, quorum_hash, total_magnitude, cpid_count, project_count, payload_size
        FROM superblocks FINAL
        ORDER BY height DESC
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: { limit, offset },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: 'SELECT count() AS c FROM superblocks FINAL',
      format: 'JSONEachRow',
    }),
  ]);
  const rows = await rowsResult.json<SuperblockRow>();
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);
  const body = SuperblockPresenter.render(rows, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

superblocksRouter.get('/:height', async (req: Request, res: Response) => {
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height')],
    });
    return;
  }
  const sbResult = await ch.query({
    query: 'SELECT * FROM superblocks FINAL WHERE height = {h: UInt32} LIMIT 1',
    query_params: { h: height },
    format: 'JSONEachRow',
  });
  const sbRows = await sbResult.json<SuperblockRow>();
  if (sbRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Superblock not found')],
    });
    return;
  }
  const row = sbRows[0];

  const blockResult = await ch.query({
    query: 'SELECT toUnixTimestamp(time) AS time FROM blocks FINAL WHERE height = {h: UInt32} LIMIT 1',
    query_params: { h: height },
    format: 'JSONEachRow',
  });
  const blockRows = await blockResult.json<{ time: number }>();
  const blockTime = blockRows[0]?.time ?? null;
  const evalAt = blockTime ?? Math.floor(Date.now() / 1000);

  const [magResult, projResult, beaconCountResult] = await Promise.all([
    ch.query({
      query: `
        SELECT cpid, magnitude FROM superblock_magnitudes FINAL
        WHERE superblock_height = {h: UInt32}
        ORDER BY magnitude DESC
      `,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT project_name, average_rac, rac, total_credit
        FROM superblock_projects FINAL
        WHERE superblock_height = {h: UInt32}
        ORDER BY rac DESC
      `,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT count() AS c FROM beacons FINAL
        WHERE block_height <= {h: UInt32}
          AND timestamp <= toDateTime({eval: UInt32})
          AND expiration > toDateTime({eval: UInt32})
          AND status != 'revoked'
          AND (superseded_at_height IS NULL OR superseded_at_height > {h: UInt32})
      `,
      query_params: { h: height, eval: evalAt },
      format: 'JSONEachRow',
    }),
  ]);
  const magnitudes = await magResult.json<{ cpid: string; magnitude: number }>();
  const projects = await projResult.json<{
    project_name: string; average_rac: number; rac: number; total_credit: number;
  }>();
  const activeBeaconCount = Number((await beaconCountResult.json<{ c: string | number }>())[0]?.c ?? 0);

  const body = SuperblockPresenter.render(row);
  res.status(StatusCodes.OK).send(withMeta(body, {
    blockTime,
    activeBeaconCount,
    magnitudes,
    projects: projects.map((p) => ({
      projectName: p.project_name,
      averageRac: p.average_rac,
      rac: p.rac,
      totalCredit: p.total_credit,
    })),
  }));
});
