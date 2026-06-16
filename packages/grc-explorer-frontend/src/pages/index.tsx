import { Box, Stack, Typography } from '@mui/material';
import type { GetServerSideProps } from 'next';
import { BeaconFlux, Flux as BeaconFluxData } from '../components/BeaconFlux';
import { BeaconSurvival, Point as BeaconSurvivalPoint } from '../components/BeaconSurvival';
import { CohortRetentionPreview, CohortPayload } from '../components/CohortRetentionPreview';
import { GradientLine } from '../components/GradientLine';
import { LazyOnVisible } from '../components/LazyOnVisible';
import {
  LiveBlockTicker, BlockEntry as LiveBlockEntry, BlockAttrs, mapBlockAttrsToEntry,
} from '../components/LiveBlockTicker';
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
  // SSR-prime ONLY the content that renders as meaningful, indexable
  // server HTML for crawlers / answer-engines / no-JS clients: the
  // network vitals, the latest-blocks list, and the projects board.
  //
  // Every other panel on this page is a JS-drawn chart / leaderboard /
  // live feed wrapped in <LazyOnVisible>. SSR-priming those gave a
  // crawler or a no-JS visitor nothing (the chart needs JS to render
  // regardless) while making TTFB the slowest of a ~17-call fan-out
  // plus a chained cohort fan-out — a measured 2.4s warm / 12.6s cold.
  // Each of those panels self-fetches on mount (their internal
  // `skipFirstFetchRef` is false when the seed is empty), so dropping
  // the seed just moves the cost off the critical path and onto the
  // panel's own LazyOnVisible/CSR path. See the homepage perf
  // investigation. This is a deliberate, scoped carve-out of the
  // SSR-first rule: text/tables stay SSR, JS-only dataviz does not.
  const [networkRes, projectsRes, blocksRes] = await Promise.allSettled([
    api.get('/network'),
    api.get('/projects'),
    // 12 rows — exactly what the latest-blocks ticker shows. The
    // 90-point txs/block chart fetches its own wider window CSR.
    api.get('/blocks', { params: { 'page[size]': 12 } }),
  ]);

  const initialNetworkStats: NetworkStats | null = networkRes.status === 'fulfilled'
    ? ((networkRes.value.data?.data?.attributes ?? null) as NetworkStats | null)
    : null;
  const initialProjectsSnap: ProjectsResponse | null = projectsRes.status === 'fulfilled'
    ? ((projectsRes.value.data?.data?.attributes ?? null) as ProjectsResponse | null)
    : null;

  // LiveBlockTicker: REST returns camelCase attrs; the component shape
  // uses snake_case to mirror the SSE payload (`tx_count` etc.). Map at
  // the boundary so the SSR seed renders the same way the SSE updates
  // do — without this, every PoS / MRC chip read "investor" after first
  // paint until the next live event.
  const initialLiveBlocks: LiveBlockEntry[] = blocksRes.status === 'fulfilled'
    ? ((blocksRes.value.data?.data ?? []) as Array<{ attributes: BlockAttrs }>)
      .map((d) => mapBlockAttrsToEntry(d.attributes)).slice(0, 12)
    : [];

  // Seed the cpid-name map only from the SSR'd blocks; useCpidNames
  // resolves everything else (the leaderboards that used to seed it
  // now hydrate CSR), and the live SSE path fills late arrivals.
  const initialCpidNames: Record<string, string> = {};
  for (const b of initialLiveBlocks) {
    if (b.staker_cpid && b.staker_name) initialCpidNames[b.staker_cpid] = b.staker_name;
  }

  // Everything below is intentionally empty: the panel hydrates itself
  // on mount/visible. Keeping the keys (not making props optional)
  // keeps the component contract and the diff minimal.
  return {
    props: {
      initialNetworkStats,
      initialMoneyFlowBuckets: [],
      initialMssMetrics: null,
      initialLeaderboard: [],
      initialLeaderboardDeltas: [],
      initialTopMovers: [],
      initialBeaconFlux: null,
      initialResearchSplit: null,
      initialProjectsSnap,
      initialStakerMix: null,
      initialWealthSnapshot: null,
      initialWealthSeries: [],
      initialLiveBlocks,
      initialTxsPerBlock: [],
      initialLiveTxFeed: [],
      initialMempoolFeeBuckets: [],
      initialFeePercentilePoints: [],
      initialFeePercentileMeta: null,
      initialBeaconSurvival: [],
      initialCohorts: [],
      initialCpidNames,
    },
  };
};
