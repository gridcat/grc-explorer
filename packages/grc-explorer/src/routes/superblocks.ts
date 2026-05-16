import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch, hasColumns } from '../lib/ch';
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
  const result = await ch.query({
    query: `
      WITH (
        SELECT count() FROM superblocks FINAL
      ) AS total,
      greatest(intDiv(total, {cap: UInt32}), 1) AS stride
      SELECT height, project_count, cpid_count, total_magnitude
      FROM (
        SELECT height, project_count, cpid_count, total_magnitude,
               row_number() OVER (ORDER BY height ASC) AS rn,
               max(height) OVER () AS max_h
        FROM superblocks FINAL
      )
      WHERE (rn - 1) % stride = 0 OR height = max_h
      ORDER BY height ASC
    `,
    query_params: { cap: TIMELINE_MAX_POINTS },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    height: number; project_count: number; cpid_count: number; total_magnitude: number;
  }>();
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
  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT height, quorum_hash, total_magnitude, cpid_count, project_count, payload_size
               ${versionSelect}
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
  const evalAt = blockTime ?? await getTipAnchor();

  const [magResult, projResult, beaconCountResult] = await Promise.all([
    ch.query({
      // No FINAL: it ignores the proj_by_superblock_height projection
      // (migration 0033) and full-scans ~4M rows. Without FINAL the
      // projection serves `WHERE superblock_height = ?` as a range
      // read; `_seq DESC LIMIT 1 BY cpid` reproduces FINAL's per-CPID
      // dedup for this superblock.
      query: `
        SELECT cpid, magnitude FROM (
          SELECT cpid, magnitude
          FROM superblock_magnitudes
          WHERE superblock_height = {h: UInt32}
          ORDER BY _seq DESC
          LIMIT 1 BY cpid
        )
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
  const rawMagnitudes = await magResult.json<{ cpid: string; magnitude: number }>();
  // Server-side names so the superblock-detail SSR seed (can be ~900
  // CPIDs) renders without fanning out parallel /cpids/names calls.
  const magNames = await resolveCpidNames(rawMagnitudes.map((m) => m.cpid));
  const magnitudes = rawMagnitudes.map((m) => ({
    ...m,
    displayName: cpidDisplayName(magNames, m.cpid),
  }));
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
