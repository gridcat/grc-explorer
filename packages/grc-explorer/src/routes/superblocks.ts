import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { hasColumns, query } from '../lib/db';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { ErrorModel } from '../lib/errors';
import { getTipAnchor } from '../lib/indexerTip';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { SuperblockPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const superblocksRouter = Router();
registerParamValidators(superblocksRouter);

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
  const height = parseInt(param(req, 'height'), 10);
  if (Number.isNaN(height)) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad height')],
    });
    return;
  }
  const sbRows = await query<SuperblockRow>(
    'SELECT * FROM superblocks WHERE height = $h LIMIT 1',
    { h: height },
  );
  if (sbRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Superblock not found')],
    });
    return;
  }
  const row = sbRows[0];

  const blockRows = await query<{ time: number }>(
    'SELECT UNIX_TIMESTAMP(time) AS time FROM blocks WHERE height = $h LIMIT 1',
    { h: height },
  );
  const blockTime = blockRows[0]?.time ?? null;
  const evalAt = blockTime ?? await getTipAnchor();

  const [rawMagnitudes, projects, beaconCountRows] = await Promise.all([
    // (cpid, superblock_height) is the PK, so each cpid appears once for
    // this superblock — no dedup needed.
    query<{ cpid: string; magnitude: number }>(
      `
        SELECT cpid, magnitude
        FROM superblock_magnitudes
        WHERE superblock_height = $h
        ORDER BY magnitude DESC
      `,
      { h: height },
    ),
    query<{
      project_name: string; average_rac: number; rac: number; total_credit: number;
    }>(
      `
        SELECT project_name, average_rac, rac, total_credit
        FROM superblock_projects
        WHERE superblock_height = $h
        ORDER BY rac DESC
      `,
      { h: height },
    ),
    query<{ c: string | number }>(
      `
        SELECT count(*) AS c FROM beacons
        WHERE block_height <= $h
          AND timestamp <= FROM_UNIXTIME($eval)
          AND expiration > FROM_UNIXTIME($eval)
          AND status != 'revoked'
          AND (superseded_at_height IS NULL OR superseded_at_height > $h)
      `,
      { h: height, eval: evalAt },
    ),
  ]);
  // Server-side names so the superblock-detail SSR seed (can be ~900
  // CPIDs) renders without fanning out parallel /cpids/names calls.
  const magNames = await resolveCpidNames(rawMagnitudes.map((m) => m.cpid));
  const magnitudes = rawMagnitudes.map((m) => ({
    ...m,
    displayName: cpidDisplayName(magNames, m.cpid),
  }));
  const activeBeaconCount = Number(beaconCountRows[0]?.c ?? 0);

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
