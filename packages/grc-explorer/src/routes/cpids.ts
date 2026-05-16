import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { byBalanceDesc, computeCombined } from '../lib/combined';
import { cpidDisplayName, resolveCpidNames } from '../lib/cpidNames';
import { halford2grc } from '../lib/halford';
import { statusOf, waitSecondsOf } from '../lib/mrcStatus';
import { getPagination } from '../lib/pagination';
import { clampedQueryInt, param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { getMoneySupplyRaw } from '../lib/supply';
import { swrCachedLiveKeyed } from '../lib/swrCache';
import {
  parseAt, parseUnixSeconds, resolveAtHeight, resolveAtSuperblockHeight,
} from '../lib/timeMachine';
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
  // Allowlist 32-char hex only; cap the unique set at 500 so an
  // untrusted caller can't pass a 100k-CPID list and turn the route
  // into a CH-grinder (useCpidNames chunks to 100/request client-side;
  // this is the server-side backstop). Internal SSR-seed enrichment
  // calls resolveCpidNames directly with no such cap.
  const requested = raw
    .toLowerCase()
    .split(',')
    .filter((s) => /^[0-9a-f]{32}$/.test(s));
  const unique = Array.from(new Set(requested)).slice(0, 500);
  const resolved = await resolveCpidNames(unique);
  const names: Record<string, string> = {};
  for (const [cpid, name] of resolved) names[cpid] = name;
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'cpid_names_batch',
      id: `batch:${unique.length}`,
      attributes: { names },
    },
  }));
});

// Resolve a BOINC display name to its CPID(s). Used by the frontend
// when a user lands on `/cpids/<name>` instead of `/cpids/<hex>` —
// SSR looks the name up here and redirects to the canonical hex URL.
//
// Returns the highest-credit CPID match when there's an exact name
// match. Falls back to a Meili prefix/substring search if no exact
// match exists. Empty `matches` means 404; consumers should show a
// friendly "no researcher by that name" page instead of erroring.
cpidsRouter.get('/resolve', async (req: Request, res: Response) => {
  const raw = String(req.query.name ?? '').trim();
  if (!raw || raw.length > 64) {
    res.status(StatusCodes.OK).send(withMeta({
      data: { type: 'cpid_resolve', id: 'empty', attributes: { matches: [] } },
    }));
    return;
  }
  // Exact match first — argMax over project_users picks the CPID
  // where this name has the most credit, which is almost always the
  // user's primary BOINC account. Doubles as the "canonical" CPID
  // when the same name exists across multiple projects.
  let matches: Array<{ cpid: string; name: string; project_name: string; total_credit: number }> = [];
  try {
    const exact = await ch.query({
      // No FINAL: bloom-pruned (idx_project_users_name, migration
      // 0032) + per-(cpid,project_name) _seq dedup + HAVING re-assert
      // — same verified pattern as resolveCpidNames / search.ts.
      query: `
        SELECT cpid, disp_name AS name, project_name, total_credit FROM (
          SELECT cpid, project_name,
                 argMax(name, _seq)         AS disp_name,
                 argMax(total_credit, _seq) AS total_credit
          FROM project_users
          WHERE name = {name: String}
          GROUP BY cpid, project_name
          HAVING disp_name = {name: String}
        )
        ORDER BY total_credit DESC
        LIMIT 10
      `,
      query_params: { name: raw },
      format: 'JSONEachRow',
    });
    matches = await exact.json<{ cpid: string; name: string; project_name: string; total_credit: number }>();
  } catch (_err) {
    // project_users absent (fresh deploy pre-migration 0015) → fall
    // through to empty matches; the frontend handles the 404 case.
  }
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'cpid_resolve',
      id: raw,
      attributes: {
        query: raw,
        matches: matches.map((m) => ({
          cpid: m.cpid,
          name: m.name,
          projectName: m.project_name,
          totalCredit: m.total_credit,
        })),
      },
    },
  }));
});

// Superblock-cadence (~daily) leaderboard with an optional compare
// window; long live-gated memo keyed by every shaping param.
const CPID_LEADERBOARD_TTL_MS = 300_000;
interface CpidLeaderboardPayload {
  data: unknown[];
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}
const getCpidLeaderboard = swrCachedLiveKeyed<CpidLeaderboardPayload>(CPID_LEADERBOARD_TTL_MS);

async function buildCpidLeaderboard(
  limit: number,
  at: number | undefined,
  rawCompareAt: number | undefined,
  compareDays: number | null,
): Promise<CpidLeaderboardPayload> {
  let compareAt = rawCompareAt;
  const currentHeight = await resolveAtSuperblockHeight(at);
  if (currentHeight === null) return { data: [] };
  if (compareAt === undefined && compareDays !== null) {
    const r = await ch.query({
      query: 'SELECT toUnixTimestamp(time) AS time FROM blocks FINAL WHERE height = {h: UInt32}',
      query_params: { h: currentHeight },
      format: 'JSONEachRow',
    });
    const t = (await r.json<{ time: number }>())[0]?.time;
    if (t !== undefined) compareAt = t - compareDays * 86_400;
  }
  const compareHeight = compareAt !== undefined ? await resolveAtSuperblockHeight(compareAt) : null;

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

  // Resolve display names server-side so the SSR seed renders names
  // without the frontend making a second /cpids/names round trip.
  const names = await resolveCpidNames(current.map((r) => r.cpid));

  return {
    data: current.map((row, idx) => {
      const rankNow = idx + 1;
      const rankThen = compareRanks.get(row.cpid);
      const rankDelta = rankThen === undefined ? null : rankThen - rankNow;
      return {
        type: 'cpid_leaderboard',
        id: row.cpid,
        attributes: {
          cpid: row.cpid,
          displayName: cpidDisplayName(names, row.cpid),
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
  };
}

cpidsRouter.get('/leaderboard', async (req: Request, res: Response) => {
  const limit = clampedQueryInt(req, 'limit', { def: 20, min: 1, max: 100 });
  const at = parseAt(req);
  const rawCompareAt = parseUnixSeconds(req, 'compare_at');
  const compareDaysRaw = parseInt(String(req.query.compare_days ?? ''), 10);
  const compareDays = Number.isFinite(compareDaysRaw) && compareDaysRaw > 0
    ? compareDaysRaw : null;
  const payload = await getCpidLeaderboard(
    `${limit}:${at ?? 'tip'}:${rawCompareAt ?? ''}:${compareDays ?? ''}`,
    () => buildCpidLeaderboard(limit, at, rawCompareAt, compareDays),
  );
  res.status(StatusCodes.OK).send(withMeta(payload));
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

  const [
    claimResult, magResult, beaconResult, blockCountResult, mrcResult, namesResult, linkedWalletsResult,
  ] = await Promise.all([
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
      // No FINAL: cpid is the LEADING ORDER BY key, so WHERE cpid is a
      // tight PK range once FINAL is gone. Dedup each project_name to
      // its latest _seq, then drop empty names post-dedup (HAVING).
      query: `
        SELECT project_name, disp_name AS name, total_credit FROM (
          SELECT project_name,
                 argMax(name, _seq)         AS disp_name,
                 argMax(total_credit, _seq) AS total_credit
          FROM project_users
          WHERE cpid = {cpid: String}
          GROUP BY project_name
          HAVING disp_name != ''
        )
        ORDER BY total_credit DESC
      `,
      query_params: { cpid },
      format: 'JSONEachRow',
    }).catch(() => null),
    // Wallet ↔ CPID linkage from three on-chain signals:
    //   • beacons.address — the researcher signed a beacon contract.
    //   • blocks.staker_cpid → miner_address — the wallet had the
    //     CPID's research key + private key to sign that coinstake.
    //   • mrc_requests.cpid → pay_to_address — the researcher chose
    //     this address as their MRC payout target.
    // The inner UNION ALL produces one row per (address, source) with
    // per-source aggregates; the outer GROUP BY collapses across
    // sources so the response is one row per distinct address.
    ch.query({
      query: `
        SELECT
          address,
          toUInt32(sumIf(c, source = 'beacon')) AS beacon_count,
          toUInt32(sumIf(c, source = 'staked')) AS staked_blocks,
          toUInt32(sumIf(c, source = 'mrc'))    AS mrc_payouts,
          toUInt32(min(first_h))                AS first_height,
          toUInt32(max(last_h))                 AS last_height
        FROM (
          SELECT address, count() AS c, 'beacon' AS source,
                 min(block_height) AS first_h, max(block_height) AS last_h
          FROM beacons FINAL
          WHERE cpid = {cpid: String} AND address != '' ${cap}
          GROUP BY address
          UNION ALL
          SELECT miner_address AS address, count() AS c, 'staked' AS source,
                 min(height) AS first_h, max(height) AS last_h
          FROM blocks FINAL
          WHERE staker_cpid = {cpid: String}
            AND miner_address IS NOT NULL AND miner_address != '' ${blockCap}
          GROUP BY miner_address
          UNION ALL
          SELECT pay_to_address AS address, count() AS c, 'mrc' AS source,
                 min(block_height) AS first_h, max(block_height) AS last_h
          FROM mrc_requests FINAL
          WHERE cpid = {cpid: String}
            AND pay_to_address IS NOT NULL AND pay_to_address != ''
            AND block_height IS NOT NULL ${cap}
          GROUP BY pay_to_address
        )
        GROUP BY address
        ORDER BY beacon_count DESC, staked_blocks DESC, mrc_payouts DESC, last_height DESC
        LIMIT 50
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
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
  const linkedWallets = await linkedWalletsResult.json<{
    address: string;
    beacon_count: number;
    staked_blocks: number;
    mrc_payouts: number;
    first_height: number;
    last_height: number;
  }>();
  // Current rank — how many CPIDs have a higher magnitude in the most
  // recent superblock this CPID appeared in? Plus 1 = their rank. If
  // they don't appear in any superblock yet, rank is null (the page
  // renders "—"). Cheap: bounded by the per-superblock CPID set
  // (~150-200 entries on mainnet).
  //
  // Fired in parallel with the claim-heights time lookup — they're
  // independent CH queries reachable from the data we already have.
  const claimHeights = claims.length > 0
    ? Array.from(new Set([claims[0].block_height, claims[claims.length - 1].block_height]))
    : [];
  const wantRank = magnitudes.length > 0 && magnitudes[0].magnitude > 0;
  const [rankRow, heightRows] = await Promise.all([
    wantRank
      ? ch.query({
        query: `
          SELECT toUInt32(count()) AS higher
          FROM superblock_magnitudes FINAL
          WHERE superblock_height = {sb: UInt32} AND magnitude > {mag: Float64}
        `,
        query_params: { sb: magnitudes[0].superblock_height, mag: magnitudes[0].magnitude },
        format: 'JSONEachRow',
      }).then((r) => r.json<{ higher: number | string }>()).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    claimHeights.length > 0
      ? ch.query({
        query: `
          SELECT height, toUnixTimestamp(time) AS time
          FROM blocks FINAL
          WHERE height IN ({hs: Array(UInt32)})
        `,
        query_params: { hs: claimHeights },
        format: 'JSONEachRow',
      }).then((r) => r.json<{ height: number; time: number }>())
      : Promise.resolve([] as Array<{ height: number; time: number }>),
  ]);
  const currentRank: number | null = rankRow ? Number(rankRow.higher) + 1 : null;
  const heightToTime = new Map<number, number>();
  for (const b of heightRows) heightToTime.set(b.height, b.time);

  // The CPID page is the authoritative "researcher profile", so the
  // combined figure lives here (the address page links up to it). The
  // displayed table stays the CPID-signal set (beacon/stake/MRC, with
  // activity columns); the combined TOTAL spans the full common-input
  // ownership cluster of those addresses — the actual wallet, what
  // gridcoinstats sums — degrading to the narrow set if the cluster
  // table is empty.
  const linkedAddrs = Array.from(new Set(linkedWallets.map((w) => w.address)));
  const supplyRaw = await getMoneySupplyRaw();
  const {
    combinedBalance, combinedSharePct, combinedCount, balMap,
  } = await computeCombined(linkedAddrs, supplyRaw);
  const linkedSorted = [...linkedWallets].sort(byBalanceDesc(balMap));

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
        currentRank,
        blocksStaked,
        beaconCount: beacons.length,
        firstClaimAt: claims.length > 0 ? claims[claims.length - 1].block_height : null,
        firstClaimTime: claims.length > 0
          ? (heightToTime.get(claims[claims.length - 1].block_height) ?? null)
          : null,
        lastClaimAt: claims.length > 0 ? claims[0].block_height : null,
        lastClaimTime: claims.length > 0
          ? (heightToTime.get(claims[0].block_height) ?? null)
          : null,
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
    combinedBalance,
    combinedSharePct,
    combinedCount,
    linkedWallets: linkedSorted.map((w) => ({
      address: w.address,
      balance: halford2grc(balMap.get(w.address) ?? 0n),
      beaconCount: w.beacon_count,
      stakedBlocks: w.staked_blocks,
      mrcPayouts: w.mrc_payouts,
      firstHeight: w.first_height,
      lastHeight: w.last_height,
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
