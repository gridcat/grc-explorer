import {
  Box, Card, CardContent, Chip, Paper, Stack, Typography,
} from '@mui/material';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { Layout } from '../../layouts/Layout';
import { Crumbs } from '../../components/Crumbs';
import { fetchYearList, type YearListItem } from '../../routes/blocks/archive/fetch';

interface HistoryProps {
  years: YearListItem[];
}

/**
 * Front door to the Gridcoin chain history. Pulls the year list (with
 * per-year aggregates) from the archive API, computes all-time totals
 * client-of-the-API-side so the header stats stay in sync as the
 * indexer ingests, and lets visitors drill into a year, then a month,
 * then a day. Eventually each year tile links into a full year article;
 * for now the destination is the bare data overview.
 *
 * SEO target: "history of gridcoin", "gridcoin timeline", "gridcoin blocks YYYY"
 * — none of which currently have an authoritative answer. Long-form prose
 * on the per-year pages (when authored) compounds with this hub.
 */
export default function HistoryLanding({ years }: HistoryProps) {
  const totalBlocks = years.reduce((s, y) => s + y.blockCount, 0);
  const totalTxs = years.reduce((s, y) => s + y.txCount, 0);
  const totalSuperblocks = years.reduce((s, y) => s + y.superblockCount, 0);
  const totalMovedGrc = years.reduce((s, y) => s + Number(y.valueMovedGrc || '0'), 0);
  const yearsCovered = years.length;
  // Years are returned newest-first; oldest is at the end of the array.
  const oldest = years[years.length - 1]?.year ?? null;
  const newest = years[0]?.year ?? null;

  return (
    <Layout>
      <Head>
        <title>Gridcoin chain history — every block, every year</title>
        <meta
          name="description"
          content={
            yearsCovered > 0
              ? `${yearsCovered} years of Gridcoin chain history (${oldest}–${newest}): ${totalBlocks.toLocaleString()} blocks, ${totalTxs.toLocaleString()} transactions, ${totalSuperblocks.toLocaleString()} superblocks. Browse by year, month, or day.`
              : 'Browse the full history of the Gridcoin chain — every block since genesis, organised by year and month, with stats and superblock landmarks.'
          }
        />
        <link rel="canonical" href="/history" />
      </Head>

      <Stack spacing={4}>
        <Crumbs items={[{ label: 'History' }]} />
        <Box sx={{ textAlign: { xs: 'left', md: 'center' }, pt: { xs: 1, md: 3 } }}>
          <Typography component="h1" variant="h3" sx={{ fontWeight: 800, mb: 1 }}>
            Gridcoin chain history
          </Typography>
          <Typography variant="h6" component="p" color="text.secondary" sx={{ maxWidth: 760, mx: 'auto' }}>
            {yearsCovered > 0
              ? `Every block from genesis to today — ${yearsCovered} years of distributed compute, science, and proof-of-research.`
              : 'The chain history will fill in as the indexer catches up. Check back as backfill progresses.'}
          </Typography>
        </Box>

        {yearsCovered > 0 && (
          <AllTimeStats
            totalBlocks={totalBlocks}
            totalTxs={totalTxs}
            totalSuperblocks={totalSuperblocks}
            totalMovedGrc={totalMovedGrc}
            yearsCovered={yearsCovered}
            oldest={oldest}
            newest={newest}
          />
        )}

        {yearsCovered > 0 && <YearsGrid years={years} />}

        <NotableEvents />
      </Stack>
    </Layout>
  );
}

function AllTimeStats({
  totalBlocks, totalTxs, totalSuperblocks, totalMovedGrc, yearsCovered, oldest, newest,
}: {
  totalBlocks: number; totalTxs: number; totalSuperblocks: number;
  totalMovedGrc: number; yearsCovered: number;
  oldest: number | null; newest: number | null;
}) {
  const tiles: Array<{ label: string; value: string }> = [
    { label: 'Years covered', value: oldest !== null && newest !== null ? `${oldest} – ${newest}` : `${yearsCovered}` },
    { label: 'Blocks', value: totalBlocks.toLocaleString() },
    { label: 'Transactions', value: totalTxs.toLocaleString() },
    { label: 'Superblocks', value: totalSuperblocks.toLocaleString() },
    { label: 'GRC moved', value: formatGrcCompact(totalMovedGrc) },
  ];
  return (
    <Stack direction="row" spacing={{ xs: 1, sm: 2 }} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'center' }}>
      {tiles.map((t) => (
        <Card
          key={t.label}
          variant="outlined"
          sx={{
            flex: { xs: '1 1 calc(50% - 4px)', sm: '0 0 180px' },
            minWidth: { xs: 0, sm: 180 },
          }}
        >
          <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
            >
              {t.label}
            </Typography>
            <Typography
              sx={{
                mt: 0.5, fontWeight: 700,
                fontSize: { xs: '1.05rem', sm: '1.5rem' },
                lineHeight: 1.25,
              }}
            >
              {t.value}
            </Typography>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function YearsGrid({ years }: { years: YearListItem[] }) {
  const max = years.reduce((m, y) => Math.max(m, y.blockCount), 0);
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2, fontWeight: 700 }}>
        Browse by year
      </Typography>
      <Box sx={{
        display: 'grid',
        gap: { xs: 1.5, sm: 2 },
        gridTemplateColumns: {
          xs: 'repeat(2, 1fr)',
          sm: 'repeat(3, 1fr)',
          md: 'repeat(4, 1fr)',
        },
      }}
      >
        {years.map((y) => <YearTile key={y.year} item={y} max={max} />)}
      </Box>
    </Box>
  );
}

function YearTile({ item, max }: { item: YearListItem; max: number }) {
  const theme = useTheme();
  const intensity = max > 0 ? item.blockCount / max : 0;
  const bg = bgForIntensity(theme, intensity);
  return (
    <Link href={`/blocks/${item.year}`} style={{ textDecoration: 'none' }}>
      <Card
        variant="outlined"
        sx={{
          bgcolor: bg,
          transition: 'transform 100ms ease, box-shadow 100ms ease',
          cursor: 'pointer',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: 3,
          },
        }}
      >
        <CardContent sx={{ p: 2 }}>
          <Typography variant="h4" component="div" sx={{ fontWeight: 800, mb: 1 }}>
            {item.year}
          </Typography>
          <Stack spacing={0.25}>
            <YearStat label="blocks" value={item.blockCount.toLocaleString()} />
            <YearStat label="txs" value={item.txCount.toLocaleString()} />
            <YearStat label="superblocks" value={item.superblockCount.toLocaleString()} />
          </Stack>
        </CardContent>
      </Card>
    </Link>
  );
}

function YearStat({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>
        {value}
      </Typography>
    </Stack>
  );
}

function bgForIntensity(theme: Theme, t: number): string {
  // Discrete stops keep visual breathing room between adjacent tiles.
  const stops = [0.12, 0.25, 0.45, 0.7, 1];
  const opacities = [0.04, 0.08, 0.14, 0.22, 0.32];
  const idx = stops.findIndex((s) => t <= s);
  const opacity = opacities[idx === -1 ? opacities.length - 1 : idx];
  return alpha(theme.palette.primary.main, opacity);
}

function formatGrcCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n;
  let idx = -1;
  while (Math.abs(v) >= 1000 && idx < units.length - 1) {
    v /= 1000;
    idx += 1;
  }
  return `${v.toFixed(2)} ${units[idx]}`;
}

/**
 * Hand-curated list of inflection points in Gridcoin's history. Static
 * for now — when per-fork article pages exist they'll live under
 * /history/<slug> and these chips become real links. Until then the
 * chips are visible-but-disabled signals of "this is what's coming."
 */
function NotableEvents() {
  // Gridcoin *Research* (the chain this explorer indexes) launched in
  // October 2014 — distinct from Gridcoin Classic, the earlier 2013
  // PoW chain that's tracked for context only. Subsequent landmarks
  // are the major consensus / economic upgrades that shaped the
  // chain's current shape.
  const events = [
    { year: 2013, label: 'Gridcoin Classic launches (predecessor chain)' },
    { year: 2014, label: 'Gridcoin Research · PoR mainnet launch' },
    { year: 2018, label: 'Fern hard fork' },
  ];
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2, fontWeight: 700 }}>
        Notable events
      </Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {events.map((e) => (
            <Chip
              key={e.label}
              label={`${e.year} — ${e.label}`}
              size="small"
              variant="outlined"
            />
          ))}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          Year-by-year deep dives are being authored now and will replace these chips with full pages.
        </Typography>
      </Paper>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<HistoryProps> = async () => {
  const years = await fetchYearList();
  return { props: { years } };
};
