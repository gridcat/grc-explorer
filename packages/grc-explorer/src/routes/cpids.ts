import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
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
// Exact-match only, by design: this drives the `/cpids/<name>`
// redirect, which needs one definitive target. Returns the
// highest-credit CPID for that name. Substring/discovery search lives
// in the global search bar's `cpid_names` bucket instead. Empty
// `matches` means 404; consumers should show a friendly "no researcher
// by that name" page instead of erroring.
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
    // (cpid, project_name) is the PK so each row is already unique —
    // no dedup needed. The name filter is the selective predicate.
    matches = await query<{ cpid: string; name: string; project_name: string; total_credit: number }>(
      `
        SELECT cpid, name, project_name, total_credit
        FROM project_users
        WHERE name = $name
        ORDER BY total_credit DESC
        LIMIT 10
      `,
      { name: raw },
    );
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
    const r = await query<{ time: number }>(
      'SELECT UNIX_TIMESTAMP(time) AS time FROM blocks WHERE height = $h',
      { h: currentHeight },
    );
    const t = r[0]?.time;
    if (t !== undefined) compareAt = t - compareDays * 86_400;
  }
  const compareHeight = compareAt !== undefined ? await resolveAtSuperblockHeight(compareAt) : null;

  const sbMagSql = (n: number) => `
    SELECT cpid, magnitude FROM superblock_magnitudes
    WHERE superblock_height = $h
    ORDER BY magnitude DESC LIMIT ${n}
  `;
  const [current, compare] = await Promise.all([
    query<{ cpid: string; magnitude: number }>(sbMagSql(limit), { h: currentHeight }),
    compareHeight !== null
      ? query<{ cpid: string; magnitude: number }>(sbMagSql(limit), { h: compareHeight })
      : Promise.resolve([] as Array<{ cpid: string; magnitude: number }>),
  ]);

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
  const cap = hasAtFilter ? 'AND block_height <= $h' : '';
  const sbCap = hasAtFilter ? 'AND superblock_height <= $h' : '';
  const blockCap = hasAtFilter ? 'AND height <= $h' : '';
  // Same predicate as `cap` but qualified for the JOIN against
  // mrc_requests so the planner doesn't see ambiguous block_height.
  const mrcCap = hasAtFilter ? 'AND m.block_height <= $h' : '';
  const params: Record<string, unknown> = { cpid };
  if (hasAtFilter) params.h = atHeight;

  const [
    claims, magnitudes, beacons, blockCountRows, mrcs, names, linkedWallets,
  ] = await Promise.all([
    query<{
      block_height: number; organization: string; block_subsidy: string;
      research_subsidy: string; magnitude: number; is_mrc: boolean;
    }>(
      `
        SELECT block_height, organization,
               CAST(block_subsidy AS CHAR)    AS block_subsidy,
               CAST(research_subsidy AS CHAR) AS research_subsidy,
               magnitude, is_mrc
        FROM claims
        WHERE cpid = $cpid ${cap}
        ORDER BY block_height DESC LIMIT 50
      `,
      params,
    ),
    query<{ superblock_height: number; magnitude: number }>(
      `
        SELECT superblock_height, magnitude FROM superblock_magnitudes
        WHERE cpid = $cpid ${sbCap}
        ORDER BY superblock_height DESC LIMIT 100
      `,
      params,
    ),
    query<{
      cpid: string; address: string; status: string; tx_id: string;
      block_height: number; timestamp: number; expiration: number; superseded_at_height: number | null;
    }>(
      `
        SELECT cpid, address, status, tx_id, block_height,
               UNIX_TIMESTAMP(timestamp)  AS timestamp,
               UNIX_TIMESTAMP(expiration) AS expiration,
               superseded_at_height
        FROM beacons
        WHERE cpid = $cpid ${cap}
        ORDER BY block_height DESC
      `,
      params,
    ),
    query<{ c: string | number }>(
      `SELECT count(*) AS c FROM blocks WHERE staker_cpid = $cpid ${blockCap}`,
      params,
    ),
    query<{
      tx_id: string; research_subsidy: string; fee_offered: string;
      first_seen: number; block_height: number | null; block_time: number | null;
      is_evicted: boolean;
    }>(
      `
        SELECT
          m.tx_id                              AS tx_id,
          CAST(m.research_subsidy AS CHAR)     AS research_subsidy,
          CAST(m.fee_offered AS CHAR)          AS fee_offered,
          UNIX_TIMESTAMP(m.first_seen)          AS first_seen,
          m.block_height                        AS block_height,
          UNIX_TIMESTAMP(m.block_time)          AS block_time,
          (mt.evicted_at IS NOT NULL)          AS is_evicted
        FROM mrc_requests AS m
        LEFT JOIN mempool_txs AS mt ON mt.tx_id = m.tx_id
        WHERE m.cpid = $cpid ${mrcCap}
        ORDER BY m.first_seen DESC LIMIT 100
      `,
      params,
    ),
    // Off-chain BOINC display names for this CPID, one per project
    // that's published a user.gz containing it. The route stays
    // resilient if the table is absent (fresh deploy pre-migration
    // 0015): empty array, the rest of the response still renders.
    // (cpid, project_name) is the PK so each project row is already
    // unique; drop empty names directly.
    query<{ project_name: string; name: string; total_credit: number }>(
      `
        SELECT project_name, name, total_credit
        FROM project_users
        WHERE cpid = $cpid AND name != ''
        ORDER BY total_credit DESC
      `,
      { cpid },
    ).catch(() => [] as Array<{ project_name: string; name: string; total_credit: number }>),
    // Wallet ↔ CPID linkage from three on-chain signals:
    //   • beacons.address — the researcher signed a beacon contract.
    //   • blocks.staker_cpid → miner_address — the wallet had the
    //     CPID's research key + private key to sign that coinstake.
    //   • mrc_requests.cpid → pay_to_address — the researcher chose
    //     this address as their MRC payout target.
    // The inner UNION ALL produces one row per (address, source) with
    // per-source aggregates; the outer GROUP BY collapses across
    // sources so the response is one row per distinct address.
    query<{
      address: string;
      beacon_count: number;
      staked_blocks: number;
      mrc_payouts: number;
      first_height: number;
      last_height: number;
    }>(
      `
        SELECT
          address,
          CAST(SUM(CASE WHEN source = 'beacon' THEN c ELSE 0 END) AS UNSIGNED) AS beacon_count,
          CAST(SUM(CASE WHEN source = 'staked' THEN c ELSE 0 END) AS UNSIGNED) AS staked_blocks,
          CAST(SUM(CASE WHEN source = 'mrc'    THEN c ELSE 0 END) AS UNSIGNED) AS mrc_payouts,
          CAST(min(first_h) AS UNSIGNED)                            AS first_height,
          CAST(max(last_h) AS UNSIGNED)                             AS last_height
        FROM (
          SELECT address, count(*) AS c, 'beacon' AS source,
                 min(block_height) AS first_h, max(block_height) AS last_h
          FROM beacons
          WHERE cpid = $cpid AND address != '' ${cap}
          GROUP BY address
          UNION ALL
          SELECT miner_address AS address, count(*) AS c, 'staked' AS source,
                 min(height) AS first_h, max(height) AS last_h
          FROM blocks
          WHERE staker_cpid = $cpid
            AND miner_address IS NOT NULL AND miner_address != '' ${blockCap}
          GROUP BY miner_address
          UNION ALL
          SELECT pay_to_address AS address, count(*) AS c, 'mrc' AS source,
                 min(block_height) AS first_h, max(block_height) AS last_h
          FROM mrc_requests
          WHERE cpid = $cpid
            AND pay_to_address IS NOT NULL AND pay_to_address != ''
            AND block_height IS NOT NULL ${cap}
          GROUP BY pay_to_address
        ) AS s
        GROUP BY address
        ORDER BY beacon_count DESC, staked_blocks DESC, mrc_payouts DESC, last_height DESC
        LIMIT 50
      `,
      params,
    ),
  ]);
  const blocksStaked = Number(blockCountRows[0]?.c ?? 0);
  // Current rank — how many CPIDs have a higher magnitude in the most
  // recent superblock this CPID appeared in? Plus 1 = their rank. If
  // they don't appear in any superblock yet, rank is null (the page
  // renders "—"). Cheap: bounded by the per-superblock CPID set
  // (~150-200 entries on mainnet).
  //
  // Fired in parallel with the claim-heights time lookup — they're
  // independent queries reachable from the data we already have.
  const claimHeights = claims.length > 0
    ? Array.from(new Set([claims[0].block_height, claims[claims.length - 1].block_height]))
    : [];
  const wantRank = magnitudes.length > 0 && magnitudes[0].magnitude > 0;
  const [rankRows, heightRows] = await Promise.all([
    wantRank
      ? query<{ higher: number | string }>(
        `
          SELECT CAST(count(*) AS UNSIGNED) AS higher
          FROM superblock_magnitudes
          WHERE superblock_height = $sb AND magnitude > $mag
        `,
        { sb: magnitudes[0].superblock_height, mag: magnitudes[0].magnitude },
      )
      : Promise.resolve([] as Array<{ higher: number | string }>),
    claimHeights.length > 0
      ? query<{ height: number; time: number }>(
        `
          SELECT height, UNIX_TIMESTAMP(time) AS time
          FROM blocks
          WHERE height IN ($hs)
        `,
        { hs: claimHeights },
      )
      : Promise.resolve([] as Array<{ height: number; time: number }>),
  ]);
  const rankRow = rankRows[0] ?? null;
  const currentRank: number | null = rankRow ? Number(rankRow.higher) + 1 : null;
  const heightToTime = new Map<number, number>();
  for (const b of heightRows) heightToTime.set(b.height, Number(b.time));

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
  const cap = atHeight !== null && at !== undefined ? 'AND height <= $h' : '';
  const params: Record<string, unknown> = { cpid };
  if (atHeight !== null && at !== undefined) params.h = atHeight;

  const [rows, countRows] = await Promise.all([
    query<{
      height: number; hash: string; time: number; is_superblock: boolean;
    }>(
      `
        SELECT height, hash, UNIX_TIMESTAMP(time) AS time, is_superblock
        FROM blocks
        WHERE staker_cpid = $cpid ${cap}
        ORDER BY height DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `,
      params,
    ),
    query<{ c: string | number }>(
      `SELECT count(*) AS c FROM blocks WHERE staker_cpid = $cpid ${cap}`,
      params,
    ),
  ]);
  const total = Number(countRows[0]?.c ?? 0);

  const claimsByHeight = new Map<number, { research_subsidy: string; block_subsidy: string; magnitude: number }>();
  if (rows.length > 0) {
    const heights = rows.map((b) => b.height);
    const cR = await query<{
      block_height: number; research_subsidy: string; block_subsidy: string; magnitude: number;
    }>(
      `
        SELECT block_height,
               CAST(research_subsidy AS CHAR) AS research_subsidy,
               CAST(block_subsidy AS CHAR)    AS block_subsidy,
               magnitude
        FROM claims WHERE block_height IN ($heights)
      `,
      { heights },
    );
    for (const c of cR) {
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
