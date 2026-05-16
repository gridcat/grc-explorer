import { Box, Stack, Typography } from '@mui/material';
import type { GetServerSideProps } from 'next';
import { BeaconFlux, Flux as BeaconFluxData } from '../components/BeaconFlux';
import { BeaconSurvival, Point as BeaconSurvivalPoint } from '../components/BeaconSurvival';
import {
  CohortRetentionPreview, CohortPayload, COHORTS_BACK, HORIZON, lastNCohortMonths,
} from '../components/CohortRetentionPreview';
import { GradientLine } from '../components/GradientLine';
import { LazyOnVisible } from '../components/LazyOnVisible';
import { LiveBlockTicker, BlockEntry as LiveBlockEntry } from '../components/LiveBlockTicker';
import { LiveTxFeed, Entry as LiveTxEntry } from '../components/LiveTxFeed';
import { MagnitudeLeaderboard, Entry as LeaderboardEntryRow, LeaderboardEntry } from '../components/MagnitudeLeaderboard';
import { MandatorySidestakesTile, MssMetrics } from '../components/MandatorySidestakesTile';
import { MempoolFeeMarket, Bucket as MempoolFeeBucket } from '../components/MempoolFeeMarket';
import {
  MempoolFeePercentiles, PercentilePoint, PercentileMeta,
} from '../components/MempoolFeePercentiles';
import { MoneyFlowChart, Bucket as MoneyFlowBucket } from '../components/MoneyFlowChart';
import { NetworkVitals, NetworkStats } from '../components/NetworkVitals';
import { ProjectsBoard, ProjectsResponse } from '../components/ProjectsBoard';
import { ResearchSplitDonut, Split as ResearchSplit } from '../components/ResearchSplitDonut';
import { StakerMix, Mix as StakerMixData } from '../components/StakerMix';
import { TopMovers, TopMoversEntry } from '../components/TopMovers';
import { TxsPerBlockChart, Point as TxsPerBlockPoint } from '../components/TxsPerBlockChart';
import {
  WealthDistributionChart, CurrentSnapshot as WealthSnapshot, SeriesPoint as WealthSeriesPoint,
} from '../components/WealthDistributionChart';
import { Layout } from '../layouts/Layout';
import { api } from '../lib/api';
import { IS_TESTNET } from '../lib/network';

// Above-the-fold widgets are rendered eagerly. Everything below is
// wrapped in <LazyOnVisible> so the panels (and their API fetches)
// don't fire until the user scrolls toward them. Initial paint of
// /home is now hero + 2 widgets, not hero + 12 charts.

interface HomeProps {
  initialNetworkStats: NetworkStats | null;
  initialMoneyFlowBuckets: MoneyFlowBucket[];
  initialMssMetrics: MssMetrics | null;
  initialLeaderboard: LeaderboardEntryRow[];
  initialLeaderboardDeltas: LeaderboardEntry[];
  initialTopMovers: TopMoversEntry[];
  initialBeaconFlux: BeaconFluxData | null;
  initialResearchSplit: ResearchSplit | null;
  initialProjectsSnap: ProjectsResponse | null;
  initialStakerMix: StakerMixData | null;
  initialWealthSnapshot: WealthSnapshot | null;
  initialWealthSeries: WealthSeriesPoint[];
  initialLiveBlocks: LiveBlockEntry[];
  initialTxsPerBlock: TxsPerBlockPoint[];
  initialLiveTxFeed: LiveTxEntry[];
  initialMempoolFeeBuckets: MempoolFeeBucket[];
  initialFeePercentilePoints: PercentilePoint[];
  initialFeePercentileMeta: PercentileMeta | null;
  initialBeaconSurvival: BeaconSurvivalPoint[];
  initialCohorts: CohortPayload[];
  initialCpidNames: Record<string, string>;
}

export default function Home({
  initialNetworkStats, initialMoneyFlowBuckets, initialMssMetrics,
  initialLeaderboard, initialLeaderboardDeltas, initialTopMovers,
  initialBeaconFlux, initialResearchSplit, initialProjectsSnap, initialStakerMix,
  initialWealthSnapshot, initialWealthSeries,
  initialLiveBlocks, initialTxsPerBlock, initialLiveTxFeed,
  initialMempoolFeeBuckets, initialFeePercentilePoints, initialFeePercentileMeta,
  initialBeaconSurvival, initialCohorts, initialCpidNames,
}: HomeProps) {
  return (
    <Layout showSearch>
      <GradientLine />

      <Box sx={{ textAlign: { xs: 'left', md: 'center' }, pb: { xs: 3, md: 5 } }}>
        <Typography
          component="h1"
          variant="h3"
          sx={{ fontWeight: 800, pb: 2 }}
        >
          The Gridcoin chain, live.
        </Typography>
        <Typography
          variant="h6"
          component="p"
          sx={{ color: 'text.secondary', maxWidth: 760, mx: 'auto' }}
        >
          {IS_TESTNET
            ? 'Browse the Gridcoin testnet. Every block, every transaction, every researcher claim, streamed in real time.'
            : 'Browse the Gridcoin blockchain. Every block, every transaction, every researcher claim, streamed in real time.'}
        </Typography>
      </Box>

      <Stack spacing={4}>
        {/* Hero / chain pulse — full-width recent blocks, then a
            full-width per-block tx histogram so the two chain-activity
            views sit side-by-side vertically. */}
        <NetworkVitals initialStats={initialNetworkStats} />
        <LazyOnVisible minHeight={220}>
          <LiveBlockTicker initialBlocks={initialLiveBlocks} initialNames={initialCpidNames} />
        </LazyOnVisible>
        <LazyOnVisible minHeight={260}>
          <TxsPerBlockChart initialPoints={initialTxsPerBlock} />
        </LazyOnVisible>

        {/* Money flow — main chart on the left, research / beacon
            decomposition stacked on the right. */}
        <LazyOnVisible minHeight={320}>
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' },
            }}
          >
            <MoneyFlowChart initialBuckets={initialMoneyFlowBuckets} />
            <Stack spacing={3}>
              <ResearchSplitDonut initialData={initialResearchSplit} />
              <BeaconFlux initialData={initialBeaconFlux} />
            </Stack>
          </Box>
        </LazyOnVisible>

        {/* Researchers / BOINC — four sub-rows, no scattered widgets.
            TopMovers swapped in here (was the money-flow rail) since
            the leaderboard hero pairs cleanly with another "who is
            doing the most" widget. */}
        <LazyOnVisible minHeight={520}>
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' },
            }}
          >
            <MagnitudeLeaderboard
              initialRows={initialLeaderboard}
              initialDeltas={initialLeaderboardDeltas}
              initialNames={initialCpidNames}
            />
            <TopMovers initialEntries={initialTopMovers} initialNames={initialCpidNames} />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={400}>
          <ProjectsBoard initialSnap={initialProjectsSnap} />
        </LazyOnVisible>
        {/* Mandatory sidestaking — protocol-driven cut of every PoS
            block reward to designated addresses, activated at V13.
            Sits below ProjectsBoard since it's another "protocol-
            governance signal" panel, and gets a tile-shaped row of
            its own because the four headline numbers (24h count,
            24h paid, recipient count, all-time paid) don't pair
            naturally with anything else on the page.
            Page-level gate on the SSR'd `forks.v13` so the lazy
            wrapper doesn't even reserve space pre-V13. The tile
            itself also self-gates via /network — the two together
            keep the gap clean both on first paint and across SSE
            refreshes. */}
        {initialNetworkStats?.forks?.v13 && (
          <LazyOnVisible minHeight={180}>
            <MandatorySidestakesTile
              initialMetrics={initialMssMetrics}
              initialV13Active={Boolean(initialNetworkStats.forks.v13)}
            />
          </LazyOnVisible>
        )}
        <LazyOnVisible minHeight={300}>
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <StakerMix initialMix={initialStakerMix} />
            <CohortRetentionPreview initialCohorts={initialCohorts} />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={300}>
          <BeaconSurvival initialPoints={initialBeaconSurvival} />
        </LazyOnVisible>

        {/* Mempool — consolidated. */}
        <LazyOnVisible minHeight={260}>
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <MempoolFeeMarket initialBuckets={initialMempoolFeeBuckets} />
            <LiveTxFeed initialEntries={initialLiveTxFeed} />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={300}>
          <MempoolFeePercentiles
            initialPoints={initialFeePercentilePoints}
            initialMeta={initialFeePercentileMeta}
          />
        </LazyOnVisible>

        {/* Wealth distribution */}
        <LazyOnVisible minHeight={400}>
          <WealthDistributionChart
            initialCurrent={initialWealthSnapshot}
            initialSeries={initialWealthSeries}
          />
        </LazyOnVisible>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async () => {
  // SSR-prime every above-fold widget per the family's SSR-first
  // policy. Each fetch is independent and `Promise.allSettled` keeps
  // the page rendering if any single upstream is down — the dependent
  // CSR refresh paths will retry on mount.
  // TopMovers uses the same /cpids/leaderboard endpoint as the
  // MagnitudeLeaderboard's rank-delta column — fetch once with
  // limit=100 (enough for TopMovers) and slice for both. The 15-row
  // leaderboard reuses the first 15 entries; the deltas map is keyed
  // by cpid so subsetting is free.
  // One blocks fetch serves both the 90-point txs/block chart and the
  // live ticker (first 12, sliced below).
  const blocksP = api.get('/blocks', { params: { 'page[size]': 90 } });
  // The cohort fan-out only needs the indexer tip time (newest block).
  // Chain it off the blocks fetch and resolve it inside the SAME
  // Promise.allSettled as everything else, so the ~COHORTS_BACK
  // cohort calls overlap the other requests instead of running as a
  // serial second SSR phase. Never rejects (→ []).
  const cohortsP: Promise<CohortPayload[]> = blocksP.then((r) => {
    const t = r.data?.data?.[0]?.attributes?.time as number | undefined;
    if (typeof t !== 'number' || t <= 0) return [];
    const monthLabels = lastNCohortMonths(COHORTS_BACK, t);
    return Promise.allSettled(monthLabels.map((cohort) => api.get(
      '/metrics/cpid-cohort-retention',
      { params: { cohort, horizon: HORIZON } },
    ))).then((res) => res
      .map((rr) => (rr.status === 'fulfilled'
        ? (rr.value.data?.data?.attributes as CohortPayload | undefined)
        : undefined))
      .filter((a): a is CohortPayload => !!a && a.cohortSize > 0));
  }).catch(() => []);

  const [
    networkRes, metricsRes, mssRes, magRes, leaderboardRes,
    beaconFluxRes, researchSplitRes, projectsRes, stakerMixRes,
    wealthRes, wealthSeriesRes,
    blocksRes, mempoolRes, feeHistogramRes,
    feePercentilesRes, beaconSurvivalRes, cohortsRes,
  ] = await Promise.allSettled([
    api.get('/network'),
    api.get('/metrics', { params: { granularity: '5min', hours: 12 } }),
    api.get('/metrics/mandatory-sidestakes'),
    api.get('/metrics/leaderboard/magnitude', { params: { limit: 15 } }),
    api.get('/cpids/leaderboard', { params: { limit: 100, compare_days: 30 } }),
    api.get('/metrics/beacon-flux', { params: { hours: 24 } }),
    api.get('/metrics/research-split', { params: { hours: 24 } }),
    api.get('/projects'),
    api.get('/metrics/staker-mix', { params: { blocks: 1000 } }),
    api.get('/metrics/wealth-distribution'),
    api.get('/metrics/wealth-distribution/series'),
    blocksP,
    api.get('/mempool', { params: { 'page[size]': 12 } }),
    api.get('/mempool/fee-histogram'),
    api.get('/metrics/fee-percentiles', { params: { granularity: '1h', hours: 24 } }),
    api.get('/metrics/beacon-survival'),
    cohortsP,
  ]);
  const liveBlocksRes = blocksRes;
  const txsPerBlockRes = blocksRes;
  const initialNetworkStats: NetworkStats | null = networkRes.status === 'fulfilled'
    ? ((networkRes.value.data?.data?.attributes ?? null) as NetworkStats | null)
    : null;
  const initialMoneyFlowBuckets: MoneyFlowBucket[] = metricsRes.status === 'fulfilled'
    ? (((metricsRes.value.data?.data ?? []) as Array<{
      attributes: {
        bucketTs: number;
        valueMoved: string;
        researchSubsidyTotal: string;
        blockSubsidyTotal: string;
      };
    }>).map((row) => ({
      bucketTs: row.attributes.bucketTs,
      txValue: Number(row.attributes.valueMoved),
      research: Number(row.attributes.researchSubsidyTotal),
      block: Number(row.attributes.blockSubsidyTotal),
    })))
    : [];
  const initialMssMetrics: MssMetrics | null = mssRes.status === 'fulfilled'
    ? ((mssRes.value.data?.data?.attributes ?? null) as MssMetrics | null)
    : null;
  const initialLeaderboard: LeaderboardEntryRow[] = magRes.status === 'fulfilled'
    ? ((magRes.value.data?.data ?? []) as Array<{ attributes: LeaderboardEntryRow }>)
      .map((d) => d.attributes)
    : [];
  // The 100-row leaderboard payload serves both panels: TopMovers
  // gets all 100 entries (it filters down to climbers/fallers/newcomers
  // client-side), and the MagnitudeLeaderboard rank-delta column maps
  // by cpid so it picks up the deltas for whichever rows it shows.
  const fullLeaderboard: LeaderboardEntry[] = leaderboardRes.status === 'fulfilled'
    ? ((leaderboardRes.value.data?.data ?? []) as Array<{ attributes: LeaderboardEntry }>)
      .map((d) => d.attributes)
    : [];
  const initialBeaconFlux: BeaconFluxData | null = beaconFluxRes.status === 'fulfilled'
    ? ((beaconFluxRes.value.data?.data?.attributes ?? null) as BeaconFluxData | null)
    : null;
  const initialResearchSplit: ResearchSplit | null = researchSplitRes.status === 'fulfilled'
    ? ((researchSplitRes.value.data?.data?.attributes ?? null) as ResearchSplit | null)
    : null;
  const initialProjectsSnap: ProjectsResponse | null = projectsRes.status === 'fulfilled'
    ? ((projectsRes.value.data?.data?.attributes ?? null) as ProjectsResponse | null)
    : null;
  const initialStakerMix: StakerMixData | null = stakerMixRes.status === 'fulfilled'
    ? ((stakerMixRes.value.data?.data?.attributes ?? null) as StakerMixData | null)
    : null;
  const initialWealthSnapshot: WealthSnapshot | null = wealthRes.status === 'fulfilled'
    ? ((wealthRes.value.data?.data?.attributes ?? null) as WealthSnapshot | null)
    : null;
  const initialWealthSeries: WealthSeriesPoint[] = wealthSeriesRes.status === 'fulfilled'
    ? (((wealthSeriesRes.value.data?.data?.attributes?.points ?? []) as WealthSeriesPoint[]))
    : [];

  // LiveBlockTicker: REST returns camelCase attrs; the component
  // shape uses snake_case to mirror the SSE payload (`tx_count` etc.).
  // Map at the boundary so the SSR seed renders the same way the SSE
  // tickets do — without this, every PoS / MRC chip read "investor"
  // after first paint until the next live event.
  const initialLiveBlocks: LiveBlockEntry[] = liveBlocksRes.status === 'fulfilled'
    ? ((liveBlocksRes.value.data?.data ?? []) as Array<{
      attributes: {
        height: number; hash: string; time: number; txCount: number;
        isPos: boolean; isSuperblock: boolean; isMrc?: boolean;
        valueMoved?: string; feeTotal?: string;
        minerAddress?: string | null; stakerCpid?: string | null;
        stakerName?: string | null;
      };
    }>).map((d) => ({
      height: d.attributes.height,
      hash: d.attributes.hash,
      time: d.attributes.time,
      tx_count: d.attributes.txCount,
      is_pos: d.attributes.isPos,
      is_superblock: d.attributes.isSuperblock,
      is_mrc: Boolean(d.attributes.isMrc),
      value_moved: d.attributes.valueMoved ?? '0',
      fee_total: d.attributes.feeTotal ?? '0',
      miner_address: d.attributes.minerAddress ?? null,
      staker_cpid: d.attributes.stakerCpid ?? null,
      staker_name: d.attributes.stakerName ?? null,
    })).slice(0, 12)
    : [];
  const initialTxsPerBlock: TxsPerBlockPoint[] = txsPerBlockRes.status === 'fulfilled'
    ? ((txsPerBlockRes.value.data?.data ?? []) as Array<{ attributes: { height: number; txCount: number } }>)
      .map((d) => ({ height: d.attributes.height, txCount: d.attributes.txCount }))
      .reverse()
    : [];
  const initialLiveTxFeed: LiveTxEntry[] = mempoolRes.status === 'fulfilled'
    ? ((mempoolRes.value.data?.data ?? []) as Array<{
      attributes: { txId: string; firstSeen: number; isMrc?: boolean };
    }>).map((d) => ({
      txId: d.attributes.txId,
      enteredAt: d.attributes.firstSeen * 1000,
      state: 'pending' as const,
      isMrc: Boolean(d.attributes.isMrc),
    }))
    : [];
  const initialMempoolFeeBuckets: MempoolFeeBucket[] = feeHistogramRes.status === 'fulfilled'
    ? ((feeHistogramRes.value.data?.data?.attributes?.buckets ?? []) as MempoolFeeBucket[])
    : [];
  // Fee-percentile points come back with p50/p95/p99 as strings; the
  // component expects numbers. Same shape conversion the CSR fetcher
  // does, just on the SSR side.
  const initialFeePercentilePoints: PercentilePoint[] = feePercentilesRes.status === 'fulfilled'
    ? ((feePercentilesRes.value.data?.data?.attributes?.points ?? []) as Array<{
      bucketTs: number; p50: string; p95: string; p99: string; txCount: number;
    }>).map((p) => ({
      bucketTs: p.bucketTs,
      p50: Number(p.p50),
      p95: Number(p.p95),
      p99: Number(p.p99),
      txCount: p.txCount,
    }))
    : [];
  const initialFeePercentileMeta: PercentileMeta | null = feePercentilesRes.status === 'fulfilled'
    ? ((feePercentilesRes.value.data?.data?.attributes ?? null) as {
      latestNonEmptyBucket: { bucketTs: number; txCount: number } | null;
      totalNonEmptyBuckets: number;
      anchor: number;
    } | null)
    : null;
  const initialBeaconSurvival: BeaconSurvivalPoint[] = beaconSurvivalRes.status === 'fulfilled'
    ? ((beaconSurvivalRes.value.data?.data?.attributes?.points ?? []) as BeaconSurvivalPoint[])
    : [];

  // Cohorts were resolved concurrently with the main fan-out (chained
  // off the blocks fetch above), not as a serial second SSR phase.
  const initialCohorts: CohortPayload[] = cohortsRes.status === 'fulfilled'
    ? cohortsRes.value
    : [];

  // Names are resolved server-side by the API now (displayName /
  // stakerName on each resource), so the first paint shows names
  // without a second /cpids/names round trip. Build the useCpidNames
  // seed from what we already fetched; the hook still handles
  // CPIDs that arrive later via the live SSE path.
  const initialCpidNames: Record<string, string> = {};
  for (const e of initialLeaderboard) {
    if (e.displayName) initialCpidNames[e.cpid] = e.displayName;
  }
  for (const e of fullLeaderboard) {
    if (e.displayName) initialCpidNames[e.cpid] = e.displayName;
  }
  for (const b of initialLiveBlocks) {
    if (b.staker_cpid && b.staker_name) initialCpidNames[b.staker_cpid] = b.staker_name;
  }

  return {
    props: {
      initialNetworkStats,
      initialMoneyFlowBuckets,
      initialMssMetrics,
      initialLeaderboard,
      initialLeaderboardDeltas: fullLeaderboard,
      initialTopMovers: fullLeaderboard as unknown as TopMoversEntry[],
      initialBeaconFlux,
      initialResearchSplit,
      initialProjectsSnap,
      initialStakerMix,
      initialWealthSnapshot,
      initialWealthSeries,
      initialLiveBlocks,
      initialTxsPerBlock,
      initialLiveTxFeed,
      initialMempoolFeeBuckets,
      initialFeePercentilePoints,
      initialFeePercentileMeta,
      initialBeaconSurvival,
      initialCohorts,
      initialCpidNames,
    },
  };
};
