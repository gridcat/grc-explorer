import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import { useState } from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { api } from '../../lib/api';
import { nowSec } from '../../lib/format';

interface Point { monthOffset: number; bucketTs: number; active: number }
interface CohortPayload {
  cohort: string;
  horizon: number;
  cohortSize: number;
  points: Point[];
}

const HORIZON = 12;
const COHORTS_BACK = 12;

/**
 * CPID cohort retention. For each of the last N months we form a cohort
 * (CPIDs first seen claiming in that month), then plot the share still
 * active each month forward up to a fixed horizon.
 *
 * Layout is small-multiples — one mini chart per cohort, in a grid. The
 * curves are normalised to 0..1 (active / cohortSize) so cohorts of
 * different sizes are comparable.
 */
interface CpidCohortsProps {
  initialCohorts: CohortPayload[];
}

export default function CpidCohortsPage({ initialCohorts }: CpidCohortsProps) {
  const [cohorts] = useState<CohortPayload[]>(initialCohorts);

  return (
    <>
      <Seo
        title="Researcher cohorts · Gridcoin Block Explorer"
        description="Gridcoin researchers grouped by join era and activity."
        path="/cpids/cohorts"
      />
    <Layout>
      <Stack spacing={3}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'Cohorts' },
        ]}
        />
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>CPID cohort retention</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            For each calendar month we form a cohort of CPIDs first seen
            claiming research reward that month, then track what share
            of that cohort is still claiming in each month thereafter.
            One small chart per cohort, normalised to the cohort&apos;s
            initial size so a 10-CPID month and a 1000-CPID month sit
            side-by-side. Taller-staying curves indicate sticky
            researchers; a steep early drop-off can mean tourists,
            hardware that didn&apos;t stick, or a project mix that
            didn&apos;t sustain long-term participation.
          </Typography>
        </Box>

        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              How to read these charts
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              <strong>What is a cohort?</strong> A group of CPIDs (researcher
              accounts) bucketed by the calendar month they first appeared
              on the chain. Specifically, the month containing the first
              block their CPID staked. So a cohort labelled <strong>2024-01</strong>{' '}
              is every CPID whose first-ever staked block landed in January
              2024.
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              <strong>What does each curve plot?</strong> Month-by-month
              survival of that cohort. The X axis is months since the
              cohort was formed (0, 1, 2, …); the Y axis is the share of
              the original cohort still active in that month, from 0 to
              1. A CPID counts as &quot;active&quot; in month N if it
              staked at least one block in that calendar month. Month 0
              is always 1.0 by construction; every member is active in
              its own joining month.
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              <strong>Worked example.</strong> Say <strong>2024-01</strong>{' '}
              has cohortSize 87 (87 CPIDs first appeared that month). If 71
              of those 87 also stake a block in February, month 1 reads
              81 %; if 41 stake in July, month 6 reads 47 %; and so on
              out to the 12-month horizon. The CPIDs don&apos;t need to
              stake every month in between, only in the specific month
              we&apos;re looking at.
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              <strong>What the shape tells you.</strong>
            </Typography>
            <Box component="ul" sx={{ pl: 3, mt: 0, mb: 1, color: 'text.secondary' }}>
              <li>
                <strong>Tall, slowly-decaying curve.</strong> Sticky cohort,
                most members kept staking. Healthy retention.
              </li>
              <li>
                <strong>Cliff in the first 1-3 months.</strong> &quot;Tourists&quot;:
                researchers who joined, tried it, and dropped off. Common
                during hype cycles.
              </li>
              <li>
                <strong>Stable middle, late drop-off.</strong> Long-term
                participants who eventually rotated out (hardware retired,
                BOINC project shut down, etc.).
              </li>
              <li>
                <strong>Curves of recent cohorts much lower than older ones.</strong>{' '}
                The chain is leaking new researchers faster than it used
                to. Worth investigating what changed.
              </li>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Caveat: a CPID is a wallet-derived identifier; if a researcher
              rotates BOINC credentials they appear as a new CPID and a new
              cohort the next month. So &quot;churn&quot; here partly reflects
              CPID rotation, not necessarily people leaving the network.
            </Typography>
          </CardContent>
        </Card>

        {cohorts.length === 0 ? (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="body2" color="text.disabled">
                No cohort data yet. Cohorts populate as the indexer
                catches up to historical superblock activity.
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <Box sx={{
            display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(3, 1fr)' },
          }}
          >
            {cohorts.map((c) => (
              <CohortTile key={c.cohort} cohort={c} />
            ))}
          </Box>
        )}
      </Stack>
    </Layout>
    </>
  );
}

function CohortTile({ cohort }: { cohort: CohortPayload }) {
  const theme = useTheme();
  const w = 260;
  const h = 96;
  const padX = 6;
  const padY = 8;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const stepX = cohort.points.length > 1 ? innerW / (cohort.points.length - 1) : 0;
  const path = cohort.points
    .map((p, i) => {
      const ratio = cohort.cohortSize > 0 ? p.active / cohort.cohortSize : 0;
      const x = padX + i * stepX;
      const y = padY + innerH - innerH * Math.min(1, Math.max(0, ratio));
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const finalRatio = cohort.points.length > 0 && cohort.cohortSize > 0
    ? (cohort.points[cohort.points.length - 1].active / cohort.cohortSize) * 100
    : 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {cohort.cohort}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {`${cohort.cohortSize.toLocaleString()} CPIDs`}
          </Typography>
        </Stack>
        <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
          <line
            x1={padX}
            x2={padX + innerW}
            y1={padY + innerH}
            y2={padY + innerH}
            stroke={theme.palette.divider}
          />
          <path d={path} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
        </svg>
        <Typography variant="caption" color="text.secondary">
          {`Month ${cohort.points.length - 1} retention: ${finalRatio.toFixed(1)}%`}
        </Typography>
      </CardContent>
    </Card>
  );
}

function lastNCohortMonths(n: number, anchorUnixSeconds: number): string[] {
  const anchor = new Date(anchorUnixSeconds * 1000);
  const out: string[] = [];
  // Skip the current month (it's incomplete) and walk backward.
  for (let i = 1; i <= n; i += 1) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export const getServerSideProps: GetServerSideProps<CpidCohortsProps> = async () => {
  // Anchor cohort labels on indexer chain-time (latest indexed block),
  // not wall-clock. Otherwise during backfill we'd request future
  // cohorts that don't exist (e.g. "2026-04" against a 2017-era
  // chain) and the page paints empty.
  let anchorTs = nowSec();
  try {
    const r = await api.get('/blocks', { params: { 'page[size]': 1 } });
    const t = r.data?.data?.[0]?.attributes?.time;
    if (typeof t === 'number' && t > 0) anchorTs = t;
  } catch { /* fall back to wall-clock — better than 500ing the page */ }

  const monthLabels = lastNCohortMonths(COHORTS_BACK, anchorTs);
  try {
    const results = await Promise.all(monthLabels.map((cohort) => api
      .get('/metrics/cpid-cohort-retention', { params: { cohort, horizon: HORIZON } })
      .then((r) => r.data?.data?.attributes as CohortPayload | undefined)
      .catch(() => undefined)));
    return {
      props: {
        initialCohorts: results.filter((c): c is CohortPayload => Boolean(c) && c!.cohortSize > 0),
      },
    };
  } catch {
    return { props: { initialCohorts: [] } };
  }
};
