import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { halford2grc } from '../lib/halford';
import { getTipAnchor } from '../lib/indexerTip';
import { withMeta } from '../lib/responseMeta';
import { parseAt } from '../lib/timeMachine';

export const metricsRouter = Router();

// The legacy `metric_buckets` table is gone — its rollups are now
// served by the network_5m / network_1h / network_1d MVs (block_count,
// tx_count, mint_total, bytes_total). The richer fields the old table
// carried (research_subsidy_total, active_addresses, new_beacons,
// researcher_blocks, investor_blocks) are computed on demand by joining
// blocks + claims + beacons. CH handles these direct aggregations fast
// thanks to columnar scans and partition pruning by time.

interface BucketRow {
  bucket_ts: number;
  block_count: number;
  tx_count: number;
  mint_total: string;
  bytes_total: number;
}

const GRANULARITY_TO_TABLE: Record<string, { table: string; bucketSec: number }> = {
  '5min': { table: 'network_5m', bucketSec: 300 },
  '1h': { table: 'network_1h', bucketSec: 3600 },
  '1d': { table: 'network_1d', bucketSec: 86400 },
};

metricsRouter.get('/', async (req: Request, res: Response) => {
  const granularityKey = (req.query.granularity === '1h' ? '1h' : '5min');
  const { table, bucketSec } = GRANULARITY_TO_TABLE[granularityKey];
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '12'), 10) || 12, 1), 168);
  const at = parseAt(req);

  const anchor = at ?? await getTipAnchor();
  // Snap right edge to the latest non-empty bucket at-or-before anchor.
  const latestResult = await ch.query({
    query: `SELECT max(bucket_ts) AS bt FROM ${table} WHERE bucket_ts <= {at: UInt32}`,
    query_params: { at: anchor },
    format: 'JSONEachRow',
  });
  const latest = (await latestResult.json<{ bt: number | null }>())[0];
  const rightEdge = latest?.bt ?? anchor;
  const since = rightEdge - hours * 3600;

  // Pull rolled-up base metrics from the MV. Pull derived metrics
  // (research, beacons, staker mix) per-bucket from the source tables
  // by binning on the same boundary the MV uses.
  const [bucketsResult, derivedResult, txResult] = await Promise.all([
    ch.query({
      // SummingMergeTree auto-collapses duplicate-key rows on merge, but
      // unmerged rows may still exist between merges. Aggregate at read
      // time so the result is correct regardless of merge state.
      query: `
        SELECT
          bucket_ts,
          sum(block_count)             AS block_count,
          sum(tx_count)                AS tx_count,
          toString(sum(mint_total))    AS mint_total,
          sum(bytes_total)             AS bytes_total
        FROM ${table}
        WHERE bucket_ts >= {since: UInt32} AND bucket_ts <= {end: UInt32}
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge },
      format: 'JSONEachRow',
    }),
    ch.query({
      // Force `bucket_ts` to UInt32 so JSONEachRow ships it as a JSON
      // number (CH defaults wider int types to JSON strings). The
      // bucket-key Map.get on the JS side has to match the network_5m
      // MV's UInt32 bucket_ts; a number-vs-string mismatch makes every
      // lookup miss and the chart goes empty.
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), {step: UInt32}) * {step: UInt32}) AS bucket_ts,
          toString(sum(coalesce(c.research_subsidy, 0))) AS research_subsidy_total,
          toString(sum(coalesce(c.block_subsidy, 0)))    AS block_subsidy_total,
          countIf(b.staker_cpid IS NOT NULL AND b.staker_cpid != '') AS researcher_blocks,
          countIf(b.staker_cpid IS NULL OR b.staker_cpid = '')       AS investor_blocks
        FROM blocks AS b FINAL
        LEFT JOIN claims AS c FINAL ON c.block_height = b.height
        WHERE b.time >= toDateTime({since: UInt32})
          AND b.time <= toDateTime({end: UInt32})
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge, step: bucketSec },
      format: 'JSONEachRow',
    }),
    ch.query({
      // Per-bucket transactions aggregate. Excludes coinbase/coinstake
      // (those are reward-emitting txs already accounted via claims —
      // including their total_out would double-count subsidies).
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), {step: UInt32}) * {step: UInt32}) AS bucket_ts,
          toString(sum(total_out)) AS value_moved,
          toString(sum(fee))       AS fee_total
        FROM transactions FINAL
        WHERE NOT is_coinbase AND NOT is_coinstake
          AND time >= toDateTime({since: UInt32})
          AND time <= toDateTime({end: UInt32})
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: rightEdge, step: bucketSec },
      format: 'JSONEachRow',
    }),
  ]);

  const buckets = await bucketsResult.json<BucketRow>();
  type DerivedRow = {
    bucket_ts: number; research_subsidy_total: string; block_subsidy_total: string;
    researcher_blocks: number; investor_blocks: number;
  };
  type TxBucketRow = { bucket_ts: number; value_moved: string; fee_total: string };
  const derivedByTs = new Map<number, DerivedRow>();
  for (const d of await derivedResult.json<DerivedRow>()) {
    derivedByTs.set(d.bucket_ts, d);
  }
  const txByTs = new Map<number, TxBucketRow>();
  for (const t of await txResult.json<TxBucketRow>()) {
    txByTs.set(t.bucket_ts, t);
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: buckets.map((r) => {
      const d = derivedByTs.get(r.bucket_ts);
      const t = txByTs.get(r.bucket_ts);
      return {
        type: 'metric_bucket',
        id: `${granularityKey}:${r.bucket_ts}`,
        attributes: {
          granularity: granularityKey,
          bucketTs: r.bucket_ts,
          txCount: r.tx_count,
          valueMoved: halford2grc(BigInt(t?.value_moved ?? '0')),
          feeTotal: halford2grc(BigInt(t?.fee_total ?? '0')),
          blockCount: r.block_count,
          researchSubsidyTotal: halford2grc(BigInt(d?.research_subsidy_total ?? '0')),
          blockSubsidyTotal: halford2grc(BigInt(d?.block_subsidy_total ?? '0')),
          activeAddresses: 0,
          newBeacons: 0,
          researcherBlocks: d?.researcher_blocks ?? 0,
          investorBlocks: d?.investor_blocks ?? 0,
        },
      };
    }),
  }));
});

metricsRouter.get('/leaderboard/magnitude', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const at = parseAt(req);

  // Latest superblock at-or-before the anchor.
  let latestHeight: number | null;
  if (at !== undefined) {
    const r = await ch.query({
      query: `
        SELECT height FROM blocks FINAL
        WHERE is_superblock = true AND time <= toDateTime({at: UInt32})
        ORDER BY height DESC LIMIT 1
      `,
      query_params: { at },
      format: 'JSONEachRow',
    });
    latestHeight = (await r.json<{ height: number }>())[0]?.height ?? null;
  } else {
    const r = await ch.query({
      query: 'SELECT height FROM superblocks FINAL ORDER BY height DESC LIMIT 1',
      format: 'JSONEachRow',
    });
    latestHeight = (await r.json<{ height: number }>())[0]?.height ?? null;
  }
  if (latestHeight === null) {
    res.status(StatusCodes.OK).send(withMeta({ data: [] }));
    return;
  }

  // Rolling 14-superblock window so a CPID dropping out of one
  // superblock doesn't dominate the row count.
  const WINDOW = 14;
  const sbResult = await ch.query({
    query: `
      SELECT height FROM superblocks FINAL
      WHERE height <= {h: UInt32}
      ORDER BY height DESC LIMIT {w: UInt32}
    `,
    query_params: { h: latestHeight, w: WINDOW },
    format: 'JSONEachRow',
  });
  const sbHeights = (await sbResult.json<{ height: number }>()).map((r) => r.height);
  if (sbHeights.length === 0) {
    res.status(StatusCodes.OK).send(withMeta({ data: [] }));
    return;
  }
  const windowMin = sbHeights[sbHeights.length - 1];

  const magResult = await ch.query({
    query: `
      SELECT cpid, superblock_height, magnitude
      FROM superblock_magnitudes FINAL
      WHERE superblock_height >= {min: UInt32} AND superblock_height <= {max: UInt32}
      ORDER BY superblock_height DESC
    `,
    query_params: { min: windowMin, max: latestHeight },
    format: 'JSONEachRow',
  });
  const windowRows = await magResult.json<{ cpid: string; superblock_height: number; magnitude: number }>();

  const latestByCpid = new Map<string, number>();
  const histByCpid = new Map<string, Array<{ height: number; magnitude: number }>>();
  for (const r of windowRows) {
    if (!latestByCpid.has(r.cpid)) latestByCpid.set(r.cpid, r.magnitude);
    const arr = histByCpid.get(r.cpid) ?? [];
    arr.push({ height: r.superblock_height, magnitude: r.magnitude });
    histByCpid.set(r.cpid, arr);
  }
  const top = [...latestByCpid.entries()]
    .map(([cpid, magnitude]) => ({ cpid, magnitude }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, limit);

  res.status(StatusCodes.OK).send(withMeta({
    data: top.map((t) => ({
      type: 'magnitude_leaderboard',
      id: t.cpid,
      attributes: {
        cpid: t.cpid,
        magnitude: t.magnitude,
        history: histByCpid.get(t.cpid) ?? [],
      },
    })),
  }));
});

metricsRouter.get('/research-split', async (req: Request, res: Response) => {
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 24 * 365);
  const at = parseAt(req) ?? await getTipAnchor();
  const since = at - hours * 3600;
  const result = await ch.query({
    query: `
      SELECT
        toString(sum(c.research_subsidy)) AS research_subsidy,
        toString(sum(c.block_subsidy))    AS block_subsidy,
        countIf(b.staker_cpid IS NOT NULL AND b.staker_cpid != '') AS researcher_blocks,
        countIf(b.staker_cpid IS NULL OR b.staker_cpid = '')       AS investor_blocks
      FROM blocks AS b FINAL
      LEFT JOIN claims AS c FINAL ON c.block_height = b.height
      WHERE b.time >= toDateTime({since: UInt32}) AND b.time <= toDateTime({end: UInt32})
    `,
    query_params: { since, end: at },
    format: 'JSONEachRow',
  });
  const row = (await result.json<{
    research_subsidy: string; block_subsidy: string;
    researcher_blocks: number; investor_blocks: number;
  }>())[0] ?? {
    research_subsidy: '0', block_subsidy: '0', researcher_blocks: 0, investor_blocks: 0,
  };
  const research = BigInt(row.research_subsidy);
  const block = BigInt(row.block_subsidy);
  const total = research + block;
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'research_split',
      id: `last_${hours}h`,
      attributes: {
        hours,
        researchSubsidy: halford2grc(research),
        blockSubsidy: halford2grc(block),
        researcherBlocks: row.researcher_blocks,
        investorBlocks: row.investor_blocks,
        researchSharePct: total > 0n ? Number((research * 10000n) / total) / 100 : 0,
      },
    },
  }));
});

metricsRouter.get('/beacon-flux', async (req: Request, res: Response) => {
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  const evalAt = parseAt(req) ?? await getTipAnchor();
  const since = evalAt - hours * 3600;
  const result = await ch.query({
    query: `
      SELECT
        countIf(timestamp <= toDateTime({end: UInt32}) AND expiration > toDateTime({end: UInt32}) AND status != 'revoked') AS active,
        countIf(timestamp >= toDateTime({since: UInt32}) AND timestamp <= toDateTime({end: UInt32}) AND status != 'revoked') AS new_,
        countIf(expiration >= toDateTime({since: UInt32}) AND expiration < toDateTime({end: UInt32})) AS expired_
      FROM beacons FINAL
    `,
    query_params: { since, end: evalAt },
    format: 'JSONEachRow',
  });
  const row = (await result.json<{ active: number; new_: number; expired_: number }>())[0]
    ?? { active: 0, new_: 0, expired_: 0 };
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'beacon_flux',
      id: `last_${hours}h`,
      attributes: {
        hours,
        active: row.active,
        new: row.new_,
        expired: row.expired_,
      },
    },
  }));
});

metricsRouter.get('/wealth-distribution', async (req: Request, res: Response) => {
  const at = parseAt(req) ?? await getTipAnchor();
  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(bucket_ts) AS bucket_ts,
        toString(total_supply)     AS total_supply,
        addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share,
        active_24h, new_24h, hodler_30d, hodler_180d
      FROM wealth_snapshots
      WHERE bucket_ts <= toDateTime({at: UInt32})
      ORDER BY bucket_ts DESC LIMIT 1
    `,
    query_params: { at },
    format: 'JSONEachRow',
  });
  const snap = (await result.json<{
    bucket_ts: number; total_supply: string; addresses_with_balance: number;
    gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
    active_24h: number; new_24h: number; hodler_30d: number; hodler_180d: number;
  }>())[0] ?? null;
  res.status(StatusCodes.OK).send(withMeta({
    data: snap
      ? {
        type: 'wealth_distribution',
        id: String(snap.bucket_ts),
        attributes: {
          bucketTs: snap.bucket_ts,
          totalSupply: halford2grc(BigInt(snap.total_supply)),
          addressesWithBalance: snap.addresses_with_balance,
          gini: Number(snap.gini),
          top1pctShare: Number(snap.top1pct_share),
          top10pctShare: Number(snap.top10pct_share),
          top100Share: Number(snap.top100_share),
          active24h: snap.active_24h,
          new24h: snap.new_24h,
          hodler30d: snap.hodler_30d,
          hodler180d: snap.hodler_180d,
        },
      }
      : null,
  }));
});

metricsRouter.get('/wealth-distribution/series', async (req: Request, res: Response) => {
  const tipAnchor = await getTipAnchor();
  const to = parseInt(String(req.query.to ?? ''), 10);
  const toTs = Number.isFinite(to) && to > 0 ? to : tipAnchor;
  const from = parseInt(String(req.query.from ?? ''), 10);
  const fromTs = Number.isFinite(from) && from > 0 ? from : toTs - 365 * 86_400;

  const result = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(bucket_ts) AS bucket_ts,
        toString(total_supply)     AS total_supply,
        addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share
      FROM wealth_snapshots
      WHERE bucket_ts >= toDateTime({from: UInt32}) AND bucket_ts <= toDateTime({to: UInt32})
      ORDER BY bucket_ts ASC
    `,
    query_params: { from: fromTs, to: toTs },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    bucket_ts: number; total_supply: string; addresses_with_balance: number;
    gini: string; top1pct_share: string; top10pct_share: string; top100_share: string;
  }>();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'wealth_distribution_series',
      id: `${fromTs}-${toTs}`,
      attributes: {
        from: fromTs,
        to: toTs,
        points: rows.map((r) => ({
          bucketTs: r.bucket_ts,
          totalSupply: halford2grc(BigInt(r.total_supply)),
          gini: Number(r.gini),
          top1pctShare: Number(r.top1pct_share),
          top10pctShare: Number(r.top10pct_share),
          top100Share: Number(r.top100_share),
          addressesWithBalance: r.addresses_with_balance,
        })),
      },
    },
  }));
});

metricsRouter.get('/fee-percentiles', async (req: Request, res: Response) => {
  // CH MV `fee_quantiles_1h` is hourly only; "5min"/"1d" map to the
  // closest available bucket size for now and re-aggregate via state
  // merging where needed. For 5min we fall back to 1h since the MV
  // doesn't carry that granularity.
  const granularityKey = (() => {
    const g = String(req.query.granularity ?? '1h');
    return ['5min', '1h', '1d'].includes(g) ? g : '1h';
  })();
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  const at = parseAt(req);
  const anchor = at ?? await getTipAnchor();

  // Three concurrent reads:
  //   1. Latest non-empty bucket at-or-before the anchor (drives the
  //      24h window's right edge).
  //   2. Absolute-latest non-empty bucket across all time (for the
  //      empty-state hint — tells the user whether the MV is bare or
  //      whether it has data outside the 24h window).
  //   3. Count of non-empty buckets across all time (so the empty-
  //      state can distinguish "MV literally bare" from "data exists
  //      but not in this window").
  const [latestInRangeResult, latestEverResult, totalResult] = await Promise.all([
    ch.query({
      query: `
        SELECT bucket_ts FROM fee_quantiles_1h
        WHERE bucket_ts <= {at: UInt32}
        GROUP BY bucket_ts
        HAVING countMerge(tx_count_state) > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      query_params: { at: anchor },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT bucket_ts, countMerge(tx_count_state) AS tx_count
        FROM fee_quantiles_1h
        GROUP BY bucket_ts
        HAVING tx_count > 0
        ORDER BY bucket_ts DESC LIMIT 1
      `,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT count() AS c FROM (
          SELECT bucket_ts FROM fee_quantiles_1h
          GROUP BY bucket_ts
          HAVING countMerge(tx_count_state) > 0
        )
      `,
      format: 'JSONEachRow',
    }),
  ]);
  const latestInRange = (await latestInRangeResult.json<{ bucket_ts: number }>())[0];
  const latestEver = (await latestEverResult.json<{ bucket_ts: number; tx_count: string | number }>())[0];
  const totalRow = (await totalResult.json<{ c: string | number }>())[0];

  const rightEdge = latestInRange?.bucket_ts ?? anchor;
  const since = rightEdge - hours * 3600;

  // HAVING tx_count > 0 filters out zero-count buckets. The MV
  // shouldn't generate them in theory (GROUP BY emits only matching
  // rows), but partial states can collapse to 0 in pathological
  // cases (e.g. early transactions inserted before the size lookup
  // fix landed, where all rows had size=0 and got dropped by the
  // WHERE filter — leaving no input but somehow a bucket entry).
  // Filtering at read time keeps the chart honest regardless.
  const result = await ch.query({
    query: `
      SELECT
        bucket_ts,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[1])) AS p50,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[2])) AS p95,
        toString(toUInt64(quantilesTDigestMerge(0.5, 0.95, 0.99)(quantile_state)[3])) AS p99,
        countMerge(tx_count_state) AS tx_count
      FROM fee_quantiles_1h
      WHERE bucket_ts >= {since: UInt32} AND bucket_ts <= {end: UInt32}
      GROUP BY bucket_ts
      HAVING tx_count > 0
      ORDER BY bucket_ts ASC
    `,
    query_params: { since, end: rightEdge },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    bucket_ts: number; p50: string; p95: string; p99: string; tx_count: string | number;
  }>();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'fee_percentiles_series',
      id: `${granularityKey}:${hours}h`,
      attributes: {
        granularity: granularityKey,
        hours,
        from: since,
        to: rightEdge,
        anchor,
        // Diagnostic fields — let the frontend tell the user "your
        // window is empty but the MV holds N buckets, latest at <date>"
        // instead of just "no data, we don't know why".
        latestNonEmptyBucket: latestEver
          ? { bucketTs: Number(latestEver.bucket_ts), txCount: Number(latestEver.tx_count) }
          : null,
        totalNonEmptyBuckets: Number(totalRow?.c ?? 0),
        points: rows.map((r) => ({
          bucketTs: Number(r.bucket_ts),
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
          txCount: Number(r.tx_count),
        })),
      },
    },
  }));
});

metricsRouter.get('/beacon-survival', async (_req: Request, res: Response) => {
  const now = await getTipAnchor();
  const since = now - 365 * 86_400;
  // CH-side cohort bucketing by month-start.
  const result = await ch.query({
    query: `
      SELECT
        formatDateTime(toStartOfMonth(timestamp), '%Y-%m')      AS cohort,
        count()                                                  AS advertised,
        countIf(status != 'revoked')                             AS confirmed,
        countIf(superseded_at_height IS NOT NULL)                AS renewed,
        countIf(expiration <= toDateTime({now: UInt32}))         AS expired_
      FROM beacons FINAL
      WHERE timestamp >= toDateTime({since: UInt32})
      GROUP BY cohort
      ORDER BY cohort ASC
    `,
    query_params: { now, since },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    cohort: string;
    advertised: string | number;
    confirmed: string | number;
    renewed: string | number;
    expired_: string | number;
  }>();
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'beacon_survival',
      id: 'last_12mo',
      attributes: {
        points: rows.map((r) => ({
          cohort: r.cohort,
          advertised: Number(r.advertised),
          confirmed: Number(r.confirmed),
          renewed: Number(r.renewed),
          expired: Number(r.expired_),
        })),
      },
    },
  }));
});

metricsRouter.get('/cpid-cohort-retention', async (req: Request, res: Response) => {
  const cohortStr = String(req.query.cohort ?? '');
  const m = cohortStr.match(/^(\d{4})-(\d{2})$/);
  if (!m) {
    res.status(StatusCodes.BAD_REQUEST).send({ errors: [{ status: 400, title: 'cohort must be YYYY-MM' }] });
    return;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const horizon = Math.min(Math.max(parseInt(String(req.query.horizon ?? '12'), 10) || 12, 1), 36);
  const cohortStart = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
  const cohortEnd = Math.floor(Date.UTC(year, month, 1) / 1000);
  const horizonEnd = Math.floor(Date.UTC(year, month - 1 + horizon, 1) / 1000);

  // CPIDs first observed staking in this cohort window.
  const cohortResult = await ch.query({
    query: `
      SELECT staker_cpid AS cpid, toUnixTimestamp(min(time)) AS first_ts
      FROM blocks FINAL
      WHERE staker_cpid IS NOT NULL AND staker_cpid != ''
      GROUP BY staker_cpid
      HAVING first_ts >= {start: UInt32} AND first_ts < {end: UInt32}
    `,
    query_params: { start: cohortStart, end: cohortEnd },
    format: 'JSONEachRow',
  });
  const cohortRows = await cohortResult.json<{ cpid: string; first_ts: number }>();
  if (cohortRows.length === 0) {
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'cpid_cohort_retention',
        id: cohortStr,
        attributes: {
          cohort: cohortStr, horizon, cohortSize: 0, points: [],
        },
      },
    }));
    return;
  }
  const cpids = cohortRows.map((c) => c.cpid);

  // Distinct cpids per month bucket within the horizon. CH's
  // toStartOfMonth bucketing handles variable month length cleanly.
  const monthlyResult = await ch.query({
    query: `
      SELECT
        toUnixTimestamp(toStartOfMonth(time)) AS bucket_ts,
        uniqExact(staker_cpid)                AS active
      FROM blocks FINAL
      WHERE staker_cpid IN ({cpids: Array(String)})
        AND time >= toDateTime({start: UInt32})
        AND time <  toDateTime({end: UInt32})
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `,
    query_params: { cpids, start: cohortStart, end: horizonEnd },
    format: 'JSONEachRow',
  });
  const monthlyRows = await monthlyResult.json<{ bucket_ts: number; active: number }>();
  const seenByBucket = new Map<number, number>();
  for (const r of monthlyRows) seenByBucket.set(r.bucket_ts, r.active);

  const points = Array.from({ length: horizon }, (_, off) => {
    const bucketTs = Math.floor(Date.UTC(year, month - 1 + off, 1) / 1000);
    return { monthOffset: off, bucketTs, active: seenByBucket.get(bucketTs) ?? 0 };
  });

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'cpid_cohort_retention',
      id: cohortStr,
      attributes: {
        cohort: cohortStr, horizon, cohortSize: cohortRows.length, points,
      },
    },
  }));
});

// Distinct staker count over the last `hours` of chain-time, ending
// at `at` (or indexer tip). The headline is the unique-CPID count
// over the whole window; the per-hour points show trend so the
// sparkline can render the network's recent activity rhythm.
//
// Computed against `blocks` directly — chain-derivable, works for any
// historical moment, doesn't depend on whether our daemon happened to
// be observing the P2P network at that time.
metricsRouter.get('/active-stakers', async (req: Request, res: Response) => {
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  const at = parseAt(req) ?? await getTipAnchor();
  const since = at - hours * 3600;

  const [headlineResult, seriesResult] = await Promise.all([
    ch.query({
      query: `
        SELECT uniqExact(staker_cpid) AS c
        FROM blocks FINAL
        WHERE time >= toDateTime({since: UInt32}) AND time <= toDateTime({end: UInt32})
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
      `,
      query_params: { since, end: at },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT
          toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
          uniqExact(staker_cpid) AS count
        FROM blocks FINAL
        WHERE time >= toDateTime({since: UInt32}) AND time <= toDateTime({end: UInt32})
          AND staker_cpid IS NOT NULL AND staker_cpid != ''
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
      `,
      query_params: { since, end: at },
      format: 'JSONEachRow',
    }),
  ]);
  const current = Number((await headlineResult.json<{ c: string | number }>())[0]?.c ?? 0);
  const points = (await seriesResult.json<{ bucket_ts: number; count: number }>()).map((p) => ({
    ts: p.bucket_ts,
    count: Number(p.count),
  }));

  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'active_stakers',
      id: `last_${hours}h`,
      attributes: {
        hours, anchor: at, current, points,
      },
    },
  }));
});

metricsRouter.get('/staker-mix', async (req: Request, res: Response) => {
  const blocks = Math.min(Math.max(parseInt(String(req.query.blocks ?? '1000'), 10) || 1000, 100), 10_000);
  const at = parseAt(req);

  // Latest block at-or-before the anchor.
  const tipResult = await ch.query({
    query: at !== undefined
      ? 'SELECT height FROM blocks FINAL WHERE time <= toDateTime({at: UInt32}) ORDER BY height DESC LIMIT 1'
      : 'SELECT height FROM blocks FINAL ORDER BY height DESC LIMIT 1',
    query_params: at !== undefined ? { at } : {},
    format: 'JSONEachRow',
  });
  const tipHeight = (await tipResult.json<{ height: number }>())[0]?.height;
  if (tipHeight === undefined) {
    res.status(StatusCodes.OK).send(withMeta({
      data: {
        type: 'staker_mix',
        id: `last_${blocks}_blocks`,
        attributes: {
          blocks: 0, researcher: 0, investor: 0, researcherSharePct: 0,
        },
      },
    }));
    return;
  }
  const minHeight = Math.max(0, tipHeight - blocks);
  const result = await ch.query({
    query: `
      SELECT
        countIf(staker_cpid IS NOT NULL AND staker_cpid != '') AS researcher,
        count() AS total
      FROM blocks FINAL
      WHERE height >= {min: UInt32} AND height <= {max: UInt32}
    `,
    query_params: { min: minHeight, max: tipHeight },
    format: 'JSONEachRow',
  });
  const row = (await result.json<{ researcher: number; total: number }>())[0]
    ?? { researcher: 0, total: 0 };
  res.status(StatusCodes.OK).send(withMeta({
    data: {
      type: 'staker_mix',
      id: `last_${blocks}_blocks`,
      attributes: {
        blocks: row.total,
        researcher: row.researcher,
        investor: row.total - row.researcher,
        researcherSharePct: row.total > 0 ? (row.researcher / row.total) * 100 : 0,
      },
    },
  }));
});
