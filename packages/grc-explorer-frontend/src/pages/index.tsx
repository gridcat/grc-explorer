import { Box, Stack, Typography } from '@mui/material';
import type { GetServerSideProps } from 'next';
import { BeaconFlux } from '../components/BeaconFlux';
import { BeaconSurvival } from '../components/BeaconSurvival';
import { CohortRetentionPreview } from '../components/CohortRetentionPreview';
import { GradientLine } from '../components/GradientLine';
import { LazyOnVisible } from '../components/LazyOnVisible';
import { LiveBlockTicker } from '../components/LiveBlockTicker';
import { LiveTxFeed } from '../components/LiveTxFeed';
import { MagnitudeLeaderboard } from '../components/MagnitudeLeaderboard';
import { MempoolFeeMarket } from '../components/MempoolFeeMarket';
import { MempoolFeePercentiles } from '../components/MempoolFeePercentiles';
import { MoneyFlowChart, Bucket as MoneyFlowBucket } from '../components/MoneyFlowChart';
import { NetworkVitals, NetworkStats } from '../components/NetworkVitals';
import { ProjectsBoard } from '../components/ProjectsBoard';
import { ResearchSplitDonut } from '../components/ResearchSplitDonut';
import { StakerMix } from '../components/StakerMix';
import { TopMovers } from '../components/TopMovers';
import { TxsPerBlockChart } from '../components/TxsPerBlockChart';
import { WealthDistributionChart } from '../components/WealthDistributionChart';
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
}

export default function Home({ initialNetworkStats, initialMoneyFlowBuckets }: HomeProps) {
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
          <LiveBlockTicker />
        </LazyOnVisible>
        <LazyOnVisible minHeight={260}>
          <TxsPerBlockChart />
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
              <ResearchSplitDonut />
              <BeaconFlux />
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
            <MagnitudeLeaderboard />
            <TopMovers />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={400}>
          <ProjectsBoard />
        </LazyOnVisible>
        <LazyOnVisible minHeight={300}>
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <StakerMix />
            <CohortRetentionPreview />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={300}>
          <BeaconSurvival />
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
            <MempoolFeeMarket />
            <LiveTxFeed />
          </Box>
        </LazyOnVisible>
        <LazyOnVisible minHeight={300}>
          <MempoolFeePercentiles />
        </LazyOnVisible>

        {/* Wealth distribution */}
        <LazyOnVisible minHeight={400}>
          <WealthDistributionChart />
        </LazyOnVisible>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async () => {
  // Pre-fill panels that look obviously broken when empty on first
  // paint — the four headline tiles and the funds-flow chart. The
  // rest of the home dashboard stays CSR (too many independent panels
  // to lift up here without regressing first-byte latency).
  const [networkRes, metricsRes] = await Promise.allSettled([
    api.get('/network'),
    api.get('/metrics', { params: { granularity: '5min', hours: 12 } }),
  ]);
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
  return { props: { initialNetworkStats, initialMoneyFlowBuckets } };
};
