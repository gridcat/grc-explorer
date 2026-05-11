import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { halford2grc } from '../lib/halford';
import { statusOf, waitSecondsOf } from '../lib/mrcStatus';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { parseAt, parseUnixSeconds, resolveAtHeight } from '../lib/timeMachine';
import { registerParamValidators } from '../lib/validators';

export const cpidsRouter = Router();
registerParamValidators(cpidsRouter);

// Static routes must be declared before any parameterised `/:cpid`
// handler, otherwise Express matches `/:cpid` first and a request to
// `/cpids/leaderboard` gets routed as the CPID "leaderboard".

// Batch CPID-to-displayName resolver. Used by the home page
// leaderboards and the LiveBlockTicker so we can fetch names for a
// dozen+ CPIDs in one round trip instead of N. Input is a
// comma-separated list of 32-char hex CPIDs; output is a
// `{ <cpid>: <name> }` map with entries only for CPIDs that have a
// non-empty published name. Caller treats missing keys as "anonymous
// or unknown" and falls back to the truncated CPID hash.
cpidsRouter.get('/names', async (req: Request, res: Response) => {
  const raw = String(req.query.cpids ?? '');
  // Allowlist 32-char lowercase hex only; cap the unique set at 200
  // so a malicious caller can't pass a 100k-CPID list and turn the
  // route into a CH-grinder.
  const requested = raw
    .toLowerCase()
    .split(',')
    .filter((s) => /^[0-9a-f]{32}$/.test(s));
  const unique = Array.from(new Set(requested)).slice(0, 200);
  const names: Record<string, string> = {};
  if (unique.length > 0) {
    try {
      // argMax(name, total_credit) — pick the BOINC project where the
      // user has the most credit as the canonical display name. Most
      // users have their primary project as the highest-credit one
      // and that's where their preferred name lives. Empty names
      // (anonymous BOINC profiles) are filtered server-side so the
      // map only carries displayable strings.
      const result = await ch.query({
        query: `
          SELECT cpid, argMax(name, total_credit) AS name
          FROM project_users FINAL
          WHERE cpid IN ({cpids: Array(String)}) AND name != ''
          GROUP BY cpid
        `,
        query_params: { cpids: unique },
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ cpid: string; name: string }>();
      for (const r of rows) if (r.name) names[r.cpid] = r.name;
    } catch (_err) {
      // Table absent (pre-migration-0015) or transient CH error —
      // empty response is a safe degradation; the UI just falls back
      // to truncated CPID hashes.
    }
  }
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'cpid_names_batch',
      id: `batch:${unique.length}`,
      attributes: { names },
    },
  }));
});

cpidsRouter.get('/leaderboard', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
  const at = parseAt(req);
  let compareAt = parseUnixSeconds(req, 'compare_at');
  const compareDaysRaw = parseInt(String(req.query.compare_days ?? ''), 10);
  const compareDays = Number.isFinite(compareDaysRaw) && compareDaysRaw > 0 ? compareDaysRaw : null;

  const findSb = async (atTime: number | undefined): Promise<number | null> => {
    if (atTime === undefined) {
      const r = await ch.query({
        query: 'SELECT height FROM superblocks FINAL ORDER BY height DESC LIMIT 1',
        format: 'JSONEachRow',
      });
      return (await r.json<{ height: number }>())[0]?.height ?? null;
    }
    const r = await ch.query({
      query: `
        SELECT height FROM blocks FINAL
        WHERE is_superblock = true AND time <= toDateTime({at: UInt32})
        ORDER BY height DESC LIMIT 1
      `,
      query_params: { at: atTime },
      format: 'JSONEachRow',
    });
    return (await r.json<{ height: number }>())[0]?.height ?? null;
  };

  const currentHeight = await findSb(at);
  if (currentHeight === null) {
    res.status(StatusCodes.OK).send(withMeta({ data: [] }));
    return;
  }
  if (compareAt === undefined && compareDays !== null) {
    const r = await ch.query({
      query: 'SELECT toUnixTimestamp(time) AS time FROM blocks FINAL WHERE height = {h: UInt32}',
      query_params: { h: currentHeight },
      format: 'JSONEachRow',
    });
    const t = (await r.json<{ time: number }>())[0]?.time;
    if (t !== undefined) compareAt = t - compareDays * 86_400;
  }
  const compareHeight = compareAt !== undefined ? await findSb(compareAt) : null;

  const [currentResult, compareResult] = await Promise.all([
    ch.query({
      query: `
        SELECT cpid, magnitude FROM superblock_magnitudes FINAL
        WHERE superblock_height = {h: UInt32}
        ORDER BY magnitude DESC LIMIT {n: UInt32}
      `,
      query_params: { h: currentHeight, n: limit },
      format: 'JSONEachRow',
    }),
    compareHeight !== null
      ? ch.query({
        query: `
          SELECT cpid, magnitude FROM superblock_magnitudes FINAL
          WHERE superblock_height = {h: UInt32}
          ORDER BY magnitude DESC LIMIT {n: UInt32}
        `,
        query_params: { h: compareHeight, n: limit },
        format: 'JSONEachRow',
      }).then((r) => r.json<{ cpid: string; magnitude: number }>())
      : Promise.resolve([] as Array<{ cpid: string; magnitude: number }>),
  ]);
  const current = await currentResult.json<{ cpid: string; magnitude: number }>();
  const compare = compareResult;

  const compareRanks = new Map<string, number>();
  compare.forEach((row, idx) => compareRanks.set(row.cpid, idx + 1));

  res.status(StatusCodes.OK).send(withMeta({
    data: current.map((row, idx) => {
      const rankNow = idx + 1;
      const rankThen = compareRanks.get(row.cpid);
      const rankDelta = rankThen === undefined ? null : rankThen - rankNow;
      return {
        type: 'cpid_leaderboard',
        id: row.cpid,
        attributes: {
          cpid: row.cpid,
          rank: rankNow,
          magnitude: row.magnitude,
          rankThen: rankThen ?? null,
          rankDelta,
          isNew: (compareAt !== undefined || compareDays !== null) && rankThen === undefined,
        },
      };
    }),
    meta: {
      currentSuperblockHeight: currentHeight,
      compareSuperblockHeight: compareHeight,
      limit,
    },
  }));
});

cpidsRouter.get('/:cpid', async (req: Request, res: Response) => {
  const cpid = param(req, 'cpid');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const hasAtFilter = atHeight !== null && at !== undefined;
  const cap = hasAtFilter ? 'AND block_height <= {h: UInt32}' : '';
  const sbCap = hasAtFilter ? 'AND superblock_height <= {h: UInt32}' : '';
  const blockCap = hasAtFilter ? 'AND height <= {h: UInt32}' : '';
  // Same predicate as `cap` but qualified for the JOIN against
  // mrc_requests so the planner doesn't see ambiguous block_height.
  const mrcCap = hasAtFilter ? 'AND m.block_height <= {h: UInt32}' : '';
  const params: Record<string, unknown> = { cpid };
  if (hasAtFilter) params.h = atHeight;

  const [claimResult, magResult, beaconResult, blockCountResult, mrcResult, namesResult] = await Promise.all([
    ch.query({
      query: `
        SELECT block_height, organization,
               toString(block_subsidy)    AS block_subsidy,
               toString(research_subsidy) AS research_subsidy,
               magnitude, is_mrc
        FROM claims FINAL
        WHERE cpid = {cpid: String} ${cap}
        ORDER BY block_height DESC LIMIT 50
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT superblock_height, magnitude FROM superblock_magnitudes FINAL
        WHERE cpid = {cpid: String} ${sbCap}
        ORDER BY superblock_height DESC LIMIT 100
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT cpid, address, status, tx_id, block_height,
               toUnixTimestamp(timestamp)  AS timestamp,
               toUnixTimestamp(expiration) AS expiration,
               superseded_at_height
        FROM beacons FINAL
        WHERE cpid = {cpid: String} ${cap}
        ORDER BY block_height DESC
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c FROM blocks FINAL WHERE staker_cpid = {cpid: String} ${blockCap}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT
          m.tx_id                       AS tx_id,
          toString(m.research_subsidy)  AS research_subsidy,
          toString(m.fee_offered)       AS fee_offered,
          toUnixTimestamp(m.first_seen) AS first_seen,
          m.block_height                AS block_height,
          toUnixTimestamp(m.block_time) AS block_time,
          (mt.evicted_at IS NOT NULL)   AS is_evicted
        FROM mrc_requests AS m FINAL
        ANY LEFT JOIN mempool_txs AS mt FINAL ON mt.tx_id = m.tx_id
        WHERE m.cpid = {cpid: String} ${mrcCap}
        ORDER BY m.first_seen DESC LIMIT 100
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    // Off-chain BOINC display names for this CPID, one per project
    // that's published a user.gz containing it. The route stays
    // resilient if the table is absent (fresh deploy pre-migration
    // 0015): empty array, the rest of the response still renders.
    ch.query({
      query: `
        SELECT project_name, name, total_credit
        FROM project_users FINAL
        WHERE cpid = {cpid: String} AND name != ''
        ORDER BY total_credit DESC
      `,
      query_params: { cpid },
      format: 'JSONEachRow',
    }).catch(() => null),
  ]);
  const claims = await claimResult.json<{
    block_height: number; organization: string; block_subsidy: string;
    research_subsidy: string; magnitude: number; is_mrc: boolean;
  }>();
  const magnitudes = await magResult.json<{ superblock_height: number; magnitude: number }>();
  const beacons = await beaconResult.json<{
    cpid: string; address: string; status: string; tx_id: string;
    block_height: number; timestamp: number; expiration: number; superseded_at_height: number | null;
  }>();
  const blocksStaked = Number((await blockCountResult.json<{ c: string | number }>())[0]?.c ?? 0);
  const mrcs = await mrcResult.json<{
    tx_id: string; research_subsidy: string; fee_offered: string;
    first_seen: number; block_height: number | null; block_time: number | null;
    is_evicted: boolean;
  }>();
  const names = namesResult
    ? await namesResult.json<{ project_name: string; name: string; total_credit: number }>()
    : [];
  // Pick the highest-total-credit non-empty name as the canonical
  // display. The full per-project list ships under `names` for the
  // CPID page's "also known as" section.
  const displayName = names[0]?.name ?? null;

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'cpid',
      id: cpid,
      attributes: {
        cpid,
        displayName,
        currentMagnitude: magnitudes[0]?.magnitude ?? 0,
        blocksStaked,
        beaconCount: beacons.length,
        firstClaimAt: claims.length > 0 ? claims[claims.length - 1].block_height : null,
        lastClaimAt: claims.length > 0 ? claims[0].block_height : null,
      },
    },
    names: names.map((n) => ({
      projectName: n.project_name,
      name: n.name,
      totalCredit: n.total_credit,
    })),
    claims: claims.map((c) => ({
      blockHeight: c.block_height,
      organization: c.organization,
      blockSubsidy: halford2grc(BigInt(c.block_subsidy)),
      researchSubsidy: halford2grc(BigInt(c.research_subsidy)),
      magnitude: c.magnitude,
      isMrc: c.is_mrc,
    })),
    magnitudes: magnitudes.map((m) => ({
      superblockHeight: m.superblock_height,
      magnitude: m.magnitude,
    })),
    beacons: beacons.map((b) => ({
      address: b.address,
      status: b.status,
      txId: b.tx_id,
      blockHeight: b.block_height,
      timestamp: b.timestamp,
      expiration: b.expiration,
    })),
    mrcs: mrcs.map((m) => ({
      txId: m.tx_id,
      researchSubsidy: halford2grc(BigInt(m.research_subsidy)),
      feeOffered: halford2grc(BigInt(m.fee_offered)),
      firstSeen: m.first_seen,
      blockHeight: m.block_height,
      blockTime: m.block_time,
      status: statusOf({ blockHeight: m.block_height, evicted: m.is_evicted }),
      waitSeconds: waitSecondsOf({
        blockHeight: m.block_height,
        firstSeen: m.first_seen,
        blockTime: m.block_time,
      }),
    })),
  }));
});

cpidsRouter.get('/:cpid/blocks', async (req: Request, res: Response) => {
  const cpid = param(req, 'cpid');
  const at = parseAt(req);
  const atHeight = at !== undefined ? await resolveAtHeight(at) : null;
  const { offset, limit } = getPagination(req);
  const cap = atHeight !== null && at !== undefined ? 'AND height <= {h: UInt32}' : '';
  const params: Record<string, unknown> = { cpid, offset, limit };
  if (atHeight !== null && at !== undefined) params.h = atHeight;

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT height, hash, toUnixTimestamp(time) AS time, is_superblock
        FROM blocks FINAL
        WHERE staker_cpid = {cpid: String} ${cap}
        ORDER BY height DESC LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c FROM blocks FINAL WHERE staker_cpid = {cpid: String} ${cap}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = await rowsResult.json<{
    height: number; hash: string; time: number; is_superblock: boolean;
  }>();
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);

  const claimsByHeight = new Map<number, { research_subsidy: string; block_subsidy: string; magnitude: number }>();
  if (rows.length > 0) {
    const heights = rows.map((b) => b.height);
    const cR = await ch.query({
      query: `
        SELECT block_height,
               toString(research_subsidy) AS research_subsidy,
               toString(block_subsidy)    AS block_subsidy,
               magnitude
        FROM claims FINAL WHERE block_height IN ({heights: Array(UInt32)})
      `,
      query_params: { heights },
      format: 'JSONEachRow',
    });
    for (const c of await cR.json<{
      block_height: number; research_subsidy: string; block_subsidy: string; magnitude: number;
    }>()) {
      claimsByHeight.set(c.block_height, c);
    }
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: rows.map((b) => {
      const c = claimsByHeight.get(b.height);
      return {
        type: 'blocks',
        id: String(b.height),
        attributes: {
          height: b.height,
          hash: b.hash,
          time: b.time,
          isSuperblock: b.is_superblock,
          researchSubsidy: c ? halford2grc(BigInt(c.research_subsidy)) : '0',
          blockSubsidy: c ? halford2grc(BigInt(c.block_subsidy)) : '0',
          magnitude: c?.magnitude ?? null,
        },
      };
    }),
    meta: { count: total },
  }));
});
