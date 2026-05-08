import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { Stat } from '../components/Stat';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { Layout } from '../layouts/Layout';
import { api } from '../lib/api';
import { formatDuration, formatGrc } from '../lib/format';
import { HashTrim } from '../components/HashTrim';
import { TimeAgo } from '../components/TimeAgo';
import { Crumbs, RESEARCHERS_CRUMB } from '../components/Crumbs';

interface Summary {
  confirmedCount: number;
  confirmedResearchTotal: string;
  confirmedFeeTotal: string;
  last24hCount: number;
  last24hResearchTotal: string;
  distinctCpids: number;
  pendingCount: number;
  evictedCount: number;
}
interface TimelinePoint {
  ts: number;
  count: number;
  researchTotal: string;
  feeTotal: string;
  distinctCpids: number;
}
interface WaitBucket { label: string; count: number }
interface WaitDistribution {
  buckets: WaitBucket[];
  p50Seconds: number | null;
  p95Seconds: number | null;
}
interface ScatterPoint {
  researchSubsidy: string;
  feeOffered: string;
  blockTime: number;
  cpid: string;
}
interface StakerTakePoint {
  ts: number;
  stakerTotal: string;
  foundationTotal: string;
  mrcBlocks: number;
}
interface MrcRow {
  txId: string;
  cpid: string;
  organization: string;
  researchSubsidy: string;
  feeOffered: string;
  firstSeen: number;
  blockHeight: number | null;
  blockTime: number | null;
  status: 'pending' | 'confirmed' | 'evicted';
  waitSeconds: number | null;
}

interface MrcDashboardProps {
  initialSummary: Summary | null;
  initialTimeline: TimelinePoint[];
  initialWaitDistribution: WaitDistribution | null;
  initialScatter: ScatterPoint[];
  initialStakerTake: StakerTakePoint[];
  initialRecent: MrcRow[];
}

const TIMELINE_DAYS = 30;
const WAIT_DAYS = 90;
const SCATTER_DAYS = 30;
const STAKER_TAKE_DAYS = 30;
const RECENT_LIMIT = 25;

export default function MrcDashboard({
  initialSummary, initialTimeline, initialWaitDistribution, initialScatter, initialStakerTake, initialRecent,
}: MrcDashboardProps) {
  const theme = useTheme();
  const [summary, setSummary] = useState<Summary | null>(initialSummary);
  const [timeline, setTimeline] = useState<TimelinePoint[]>(initialTimeline);
  const [wait, setWait] = useState<WaitDistribution | null>(initialWaitDistribution);
  const [scatter, setScatter] = useState<ScatterPoint[]>(initialScatter);
  const [stakerTake, setStakerTake] = useState<StakerTakePoint[]>(initialStakerTake);
  const [recent, setRecent] = useState<MrcRow[]>(initialRecent);

  // Refresh every 60s — the data is per-block-cadence, no need for SSE here.
  useEffect(() => {
    const refresh = async () => {
      try {
        const [s, t, w, b, k, r] = await Promise.all([
          api.get('/mrc-requests/summary'),
          api.get('/mrc-requests/timeline', { params: { days: TIMELINE_DAYS } }),
          api.get('/mrc-requests/wait-distribution', { params: { days: WAIT_DAYS } }),
          api.get('/mrc-requests/bid-vs-payout', { params: { days: SCATTER_DAYS } }),
          api.get('/mrc-requests/staker-take', { params: { days: STAKER_TAKE_DAYS } }),
          api.get('/mrc-requests', { params: { 'page[size]': RECENT_LIMIT } }),
        ]);
        setSummary(s.data?.data?.attributes ?? null);
        setTimeline(t.data?.data?.attributes?.samples ?? []);
        setWait(w.data?.data?.attributes ?? null);
        setScatter(b.data?.data?.attributes?.points ?? []);
        setStakerTake(k.data?.data?.attributes?.samples ?? []);
        const rows = (r.data?.data ?? []) as Array<{ attributes: MrcRow }>;
        setRecent(rows.map((d) => d.attributes));
      } catch { /* ignore */ }
    };
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <Layout>
      <Stack spacing={3}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'MRC requests' },
        ]}
        />
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>MRC requests</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Manual Researcher Compensation: a researcher submits a request
            transaction with a small bid fee, and a future staker bundles
            their payout into the next block&apos;s claim. This page tracks
            every request the explorer has observed — both pending in
            mempool and confirmed in chain — plus historical MRCs reconstructed
            from past blocks (for those, &ldquo;wait time&rdquo; is unknowable).
          </Typography>
        </Box>

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' } }}>
          <Stat size="sm" label="Total confirmed" value={summary?.confirmedCount?.toLocaleString() ?? '—'} />
          <Stat size="sm" label="Research paid (lifetime)" value={summary ? `${formatGrc(summary.confirmedResearchTotal)} GRC` : '—'} />
          <Stat size="sm" label="Distinct researchers" value={summary?.distinctCpids?.toLocaleString() ?? '—'} />
          <Stat
            size="sm"
            label="Last 24h"
            value={summary ? `${summary.last24hCount} req · ${formatGrc(summary.last24hResearchTotal)} GRC` : '—'}
          />
        </Box>

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary">
                Daily activity · last {TIMELINE_DAYS} days
              </Typography>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={timeline} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    fontSize={11}
                  />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString()}
                    formatter={(value: number, key: string) => (key === 'count' ? [value, 'MRCs'] : [value, key])}
                  />
                  <Line type="monotone" dataKey="count" stroke={theme.palette.primary.main} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Typography variant="subtitle2" color="text.secondary">
                  Wait time distribution · last {WAIT_DAYS} days
                </Typography>
                {wait && wait.p50Seconds !== null && (
                  <Typography variant="caption" color="text.secondary">
                    p50 {formatDuration(wait.p50Seconds)} · p95 {formatDuration(wait.p95Seconds ?? 0)}
                  </Typography>
                )}
              </Stack>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={wait?.buckets ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis dataKey="label" fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count">
                    {(wait?.buckets ?? []).map((entry) => (
                      <Cell key={entry.label} fill={theme.palette.primary.main} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {(wait?.p50Seconds ?? null) === null && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  No live-observed MRCs in the window — historical replay rows are excluded
                  because their wait time is undefined.
                </Typography>
              )}
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Typography variant="subtitle2" color="text.secondary">
                  Staker take from MRC · last {STAKER_TAKE_DAYS} days
                </Typography>
                {stakerTake.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    {stakerTake.reduce((acc, p) => acc + p.mrcBlocks, 0)} blocks bundled MRCs
                  </Typography>
                )}
              </Stack>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={stakerTake.map((p) => ({
                    ts: p.ts,
                    staker: Number(p.stakerTotal),
                    foundation: Number(p.foundationTotal),
                  }))}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    fontSize={11}
                  />
                  <YAxis fontSize={11} tickFormatter={(v: number) => `${v.toFixed(2)}`} />
                  <Tooltip
                    labelFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString()}
                    formatter={(value: number, key: string) => [`${value.toFixed(8)} GRC`, key === 'staker' ? 'Staker' : 'Foundation']}
                  />
                  <Bar dataKey="staker" stackId="fees" fill={theme.palette.success.main} />
                  <Bar dataKey="foundation" stackId="fees" fill={theme.palette.warning.main} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card variant="outlined" sx={{ gridColumn: { xs: 'auto', md: 'span 2' } }}>
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary">
                Bid fee vs requested payout · last {SCATTER_DAYS} days
              </Typography>
              <ResponsiveContainer width="100%" height={260}>
                <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis
                    dataKey="researchSubsidy"
                    type="number"
                    domain={['auto', 'auto']}
                    fontSize={11}
                    tickFormatter={(v: number) => `${v.toLocaleString()} GRC`}
                    name="Requested"
                  />
                  <YAxis
                    dataKey="feeOffered"
                    type="number"
                    domain={['auto', 'auto']}
                    fontSize={11}
                    tickFormatter={(v: number) => `${v.toFixed(3)} GRC`}
                    name="Bid fee"
                  />
                  <ZAxis range={[40, 40]} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    formatter={(value: number, key: string) => {
                      if (key === 'researchSubsidy') return [`${value.toLocaleString()} GRC`, 'Requested'];
                      if (key === 'feeOffered') return [`${value.toFixed(8)} GRC`, 'Bid fee'];
                      return [value, key];
                    }}
                  />
                  <Scatter
                    data={scatter.map((p) => ({
                      researchSubsidy: Number(p.researchSubsidy),
                      feeOffered: Number(p.feeOffered),
                    }))}
                    fill={theme.palette.secondary.main}
                  />
                </ScatterChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Box>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">Recent MRC requests</Typography>
            <Stack direction="row" spacing={1}>
              {summary && summary.pendingCount > 0 && (
                <Chip size="small" label={`${summary.pendingCount} pending`} color="primary" variant="outlined" />
              )}
              {summary && summary.evictedCount > 0 && (
                <Chip size="small" label={`${summary.evictedCount} evicted`} variant="outlined" />
              )}
            </Stack>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tx</TableCell>
                <TableCell>Researcher</TableCell>
                <TableCell align="right">Requested</TableCell>
                <TableCell align="right">Bid fee</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Block</TableCell>
                <TableCell>First seen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recent.map((m) => (
                <TableRow key={m.txId} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/transactions/${m.txId}`} style={{ color: 'inherit' }}>
                      <HashTrim text={m.txId} head={10} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/cpids/${m.cpid}`} style={{ color: 'inherit' }}>
                      <HashTrim text={m.cpid} head={8} tail={4} />
                    </Link>
                  </TableCell>
                  <TableCell align="right">{formatGrc(m.researchSubsidy)}</TableCell>
                  <TableCell align="right">{formatGrc(m.feeOffered)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={m.status}
                      color={m.status === 'confirmed' ? 'success' : m.status === 'evicted' ? 'default' : 'primary'}
                      variant={m.status === 'pending' ? 'filled' : 'outlined'}
                    />
                  </TableCell>
                  <TableCell>
                    {m.blockHeight !== null ? (
                      <Link href={`/block/${m.blockHeight}`} style={{ color: 'inherit' }}>#{m.blockHeight}</Link>
                    ) : <span style={{ opacity: 0.5 }}>—</span>}
                  </TableCell>
                  <TableCell><TimeAgo unixSec={m.firstSeen} /></TableCell>
                </TableRow>
              ))}
              {recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ textAlign: 'center', color: 'text.secondary', py: 3 }}>
                    No MRC requests observed yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<MrcDashboardProps> = async () => {
  try {
    const [s, t, w, b, k, r] = await Promise.all([
      api.get('/mrc-requests/summary'),
      api.get('/mrc-requests/timeline', { params: { days: TIMELINE_DAYS } }),
      api.get('/mrc-requests/wait-distribution', { params: { days: WAIT_DAYS } }),
      api.get('/mrc-requests/bid-vs-payout', { params: { days: SCATTER_DAYS } }),
      api.get('/mrc-requests/staker-take', { params: { days: STAKER_TAKE_DAYS } }),
      api.get('/mrc-requests', { params: { 'page[size]': RECENT_LIMIT } }),
    ]);
    const recentRows = (r.data?.data ?? []) as Array<{ attributes: MrcRow }>;
    return {
      props: {
        initialSummary: s.data?.data?.attributes ?? null,
        initialTimeline: t.data?.data?.attributes?.samples ?? [],
        initialWaitDistribution: w.data?.data?.attributes ?? null,
        initialScatter: b.data?.data?.attributes?.points ?? [],
        initialStakerTake: k.data?.data?.attributes?.samples ?? [],
        initialRecent: recentRows.map((d) => d.attributes),
      },
    };
  } catch {
    return {
      props: {
        initialSummary: null,
        initialTimeline: [],
        initialWaitDistribution: null,
        initialScatter: [],
        initialStakerTake: [],
        initialRecent: [],
      },
    };
  }
};
