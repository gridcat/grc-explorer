import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead,
  TablePagination, TableRow, TableSortLabel, Typography,
} from '@mui/material';
import { Stat } from '../components/Stat';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { Layout } from '../layouts/Layout';
import { api } from '../lib/api';
import {
  formatDuration, formatGrc, formatNumber, formatUnixDate, formatUnixDateShort,
} from '../lib/format';
import { makeRechartsTooltip } from '../components/charts/RechartsTooltip';
import { HashTrim } from '../components/HashTrim';
import { TimeAgo } from '../components/TimeAgo';
import { Crumbs, RESEARCHERS_CRUMB } from '../components/Crumbs';
import {
  PAGE_SIZE_OPTIONS, pushPaginationQuery, readPageFromQuery, readPageSizeFromQuery,
} from '../lib/pagination';

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
  initialRecentTotal: number;
  initialPage: number;
  initialPageSize: number;
  initialSort: string;
}

const TIMELINE_DAYS = 30;
const WAIT_DAYS = 90;
const SCATTER_DAYS = 30;
const STAKER_TAKE_DAYS = 30;

// Whitelist must mirror the backend (`routes/mrcRequests.ts:SORTABLE`).
// Any value not in this set falls back to `-first_seen` server-side, so
// stale shareable links can't error.
type SortField = 'first_seen' | 'block_height' | 'research_subsidy' | 'fee_offered';
type SortDir = 'asc' | 'desc';
const SORT_FIELDS: ReadonlyArray<SortField> = ['first_seen', 'block_height', 'research_subsidy', 'fee_offered'];

function parseSort(raw: string | string[] | undefined): { field: SortField; dir: SortDir } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return { field: 'first_seen', dir: 'desc' };
  const dir: SortDir = value.startsWith('-') ? 'desc' : 'asc';
  const field = value.replace(/^-/, '') as SortField;
  if (!SORT_FIELDS.includes(field)) return { field: 'first_seen', dir: 'desc' };
  return { field, dir };
}

function formatSort(field: SortField, dir: SortDir): string {
  return `${dir === 'desc' ? '-' : ''}${field}`;
}

const STATUS_CHIP_COLOR: Record<MrcRow['status'], 'success' | 'default' | 'primary'> = {
  confirmed: 'success',
  evicted: 'default',
  pending: 'primary',
};

export default function MrcDashboard({
  initialSummary, initialTimeline, initialWaitDistribution, initialScatter, initialStakerTake,
  initialRecent, initialRecentTotal, initialPage, initialPageSize, initialSort,
}: MrcDashboardProps) {
  const theme = useTheme();
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(initialSummary);
  const [timeline, setTimeline] = useState<TimelinePoint[]>(initialTimeline);
  const [wait, setWait] = useState<WaitDistribution | null>(initialWaitDistribution);
  const [scatter, setScatter] = useState<ScatterPoint[]>(initialScatter);
  const [stakerTake, setStakerTake] = useState<StakerTakePoint[]>(initialStakerTake);
  const [recent, setRecent] = useState<MrcRow[]>(initialRecent);
  const [recentTotal, setRecentTotal] = useState<number>(initialRecentTotal);
  const [recentLoading, setRecentLoading] = useState(false);

  const page = readPageFromQuery(router.query);
  const pageSize = readPageSizeFromQuery(router.query);
  const sort = parseSort(router.query.sort);

  // Skip the first table refetch — SSR already hydrated us with the
  // exact (page, pageSize, sort) the URL asked for. Only refetch when
  // any of those change after mount.
  const initialKey = `${initialPage}/${initialPageSize}/${initialSort}`;
  const lastFetchedKey = useRef(initialKey);
  useEffect(() => {
    const key = `${page}/${pageSize}/${formatSort(sort.field, sort.dir)}`;
    if (key === lastFetchedKey.current) return;
    lastFetchedKey.current = key;
    let cancelled = false;
    setRecentLoading(true);
    api.get('/mrc-requests', {
      params: {
        'page[number]': page + 1,
        'page[size]': pageSize,
        sort: formatSort(sort.field, sort.dir),
      },
    }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: MrcRow }>;
      setRecent(data.map((d) => d.attributes));
      setRecentTotal(Number(r.data?.meta?.count ?? 0));
    }).catch(() => { /* keep last good rows */ }).finally(() => {
      if (!cancelled) setRecentLoading(false);
    });
    return () => { cancelled = true; };
  }, [page, pageSize, sort.field, sort.dir]);

  const updatePagination = (next: { page?: number; pageSize?: number }) => {
    pushPaginationQuery(router, next);
  };

  const toggleSort = (field: SortField) => {
    // Same field → flip direction; new field → start with desc, since
    // most numeric columns are most useful largest-first.
    const nextDir: SortDir = sort.field === field
      ? (sort.dir === 'desc' ? 'asc' : 'desc')
      : 'desc';
    router.replace(
      {
        pathname: router.pathname,
        query: {
          ...router.query,
          sort: formatSort(field, nextDir),
          page: '0',
        },
      },
      undefined,
      { scroll: false, shallow: true },
    );
  };

  // One tooltip component per chart. Memoised on theme so a dark/light
  // mode flip rebuilds the closure (the swatch colour changes), but
  // ordinary refresh ticks don't churn the recharts content prop.
  const TimelineTooltip = useMemo(() => makeRechartsTooltip((payload, label) => ({
    title: typeof label === 'number' ? formatUnixDate(label) : undefined,
    rows: [{
      label: 'MRCs',
      value: formatNumber(Number(payload[0]?.value ?? 0)),
      color: theme.palette.primary.main,
    }],
  })), [theme.palette.primary.main]);

  const WaitTooltip = useMemo(() => makeRechartsTooltip((payload, label) => ({
    title: typeof label === 'string' ? `Wait ${label}` : undefined,
    rows: [{
      label: 'Count',
      value: formatNumber(Number(payload[0]?.value ?? 0)),
      color: theme.palette.primary.main,
    }],
  })), [theme.palette.primary.main]);

  const StakerTakeTooltip = useMemo(() => makeRechartsTooltip((payload, label) => ({
    title: typeof label === 'number' ? formatUnixDate(label) : undefined,
    rows: payload.map((p) => ({
      label: p.dataKey === 'staker' ? 'Staker' : 'Foundation',
      value: `${Number(p.value ?? 0).toFixed(8)} GRC`,
      color: p.color
        ?? (p.dataKey === 'staker' ? theme.palette.success.main : theme.palette.warning.main),
    })),
  })), [theme.palette.success.main, theme.palette.warning.main]);

  const ScatterTooltip = useMemo(() => makeRechartsTooltip((payload) => {
    const point = payload[0]?.payload as
      | { researchSubsidy?: number; feeOffered?: number }
      | undefined;
    if (!point) return null;
    return {
      rows: [
        {
          label: 'Requested',
          value: `${Number(point.researchSubsidy ?? 0).toLocaleString()} GRC`,
          color: theme.palette.secondary.main,
        },
        {
          label: 'Bid fee',
          value: `${Number(point.feeOffered ?? 0).toFixed(8)} GRC`,
        },
      ],
    };
  }), [theme.palette.secondary.main]);

  // Refresh the dashboard charts + summary every 60s — data is per-
  // block-cadence so SSE isn't worth the wiring here. The recent-MRC
  // table refresh is intentionally separate (see the URL-driven effect
  // above): the user's page/sort selection has to survive a refresh
  // tick, and merging the two would clobber it.
  useEffect(() => {
    const refresh = async () => {
      try {
        const [s, t, w, b, k] = await Promise.all([
          api.get('/mrc-requests/summary'),
          api.get('/mrc-requests/timeline', { params: { days: TIMELINE_DAYS } }),
          api.get('/mrc-requests/wait-distribution', { params: { days: WAIT_DAYS } }),
          api.get('/mrc-requests/bid-vs-payout', { params: { days: SCATTER_DAYS } }),
          api.get('/mrc-requests/staker-take', { params: { days: STAKER_TAKE_DAYS } }),
        ]);
        setSummary(s.data?.data?.attributes ?? null);
        setTimeline(t.data?.data?.attributes?.samples ?? []);
        setWait(w.data?.data?.attributes ?? null);
        setScatter(b.data?.data?.attributes?.points ?? []);
        setStakerTake(k.data?.data?.attributes?.samples ?? []);
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
          <Stat size="sm" label="Total confirmed" value={summary ? formatNumber(summary.confirmedCount) : '—'} />
          <Stat size="sm" label="Research paid (lifetime)" value={summary ? `${formatGrc(summary.confirmedResearchTotal)} GRC` : '—'} />
          <Stat size="sm" label="Distinct researchers" value={summary ? formatNumber(summary.distinctCpids) : '—'} />
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
                    tickFormatter={formatUnixDateShort}
                    fontSize={11}
                  />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    cursor={{ stroke: theme.palette.divider, strokeDasharray: '3 3' }}
                    content={<TimelineTooltip />}
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
                  <Tooltip
                    cursor={{ fill: theme.palette.action.hover }}
                    content={<WaitTooltip />}
                  />
                  <Bar dataKey="count" fill={theme.palette.primary.main} />
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
                    tickFormatter={formatUnixDateShort}
                    fontSize={11}
                  />
                  <YAxis fontSize={11} tickFormatter={(v: number) => `${v.toFixed(2)}`} />
                  <Tooltip
                    cursor={{ fill: theme.palette.action.hover }}
                    content={<StakerTakeTooltip />}
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
                    cursor={{ stroke: theme.palette.divider, strokeDasharray: '3 3' }}
                    content={<ScatterTooltip />}
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

        <Paper variant="outlined" sx={{ overflowX: 'auto', opacity: recentLoading ? 0.6 : 1, transition: 'opacity 120ms' }}>
          <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">MRC requests</Typography>
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
                <TableCell align="right" sortDirection={sort.field === 'research_subsidy' ? sort.dir : false}>
                  <TableSortLabel
                    active={sort.field === 'research_subsidy'}
                    direction={sort.field === 'research_subsidy' ? sort.dir : 'desc'}
                    onClick={() => toggleSort('research_subsidy')}
                  >
                    Requested
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right" sortDirection={sort.field === 'fee_offered' ? sort.dir : false}>
                  <TableSortLabel
                    active={sort.field === 'fee_offered'}
                    direction={sort.field === 'fee_offered' ? sort.dir : 'desc'}
                    onClick={() => toggleSort('fee_offered')}
                  >
                    Bid fee
                  </TableSortLabel>
                </TableCell>
                <TableCell>Status</TableCell>
                <TableCell sortDirection={sort.field === 'block_height' ? sort.dir : false}>
                  <TableSortLabel
                    active={sort.field === 'block_height'}
                    direction={sort.field === 'block_height' ? sort.dir : 'desc'}
                    onClick={() => toggleSort('block_height')}
                  >
                    Block
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sort.field === 'first_seen' ? sort.dir : false}>
                  <TableSortLabel
                    active={sort.field === 'first_seen'}
                    direction={sort.field === 'first_seen' ? sort.dir : 'desc'}
                    onClick={() => toggleSort('first_seen')}
                  >
                    First seen
                  </TableSortLabel>
                </TableCell>
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
                      color={STATUS_CHIP_COLOR[m.status]}
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
              {recent.length === 0 && !recentLoading && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ textAlign: 'center', color: 'text.secondary', py: 3 }}>
                    No MRC requests observed yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={recentTotal}
            page={page}
            onPageChange={(_, p) => updatePagination({ page: p })}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onRowsPerPageChange={(e) => updatePagination({ page: 0, pageSize: parseInt(e.target.value, 10) })}
          />
        </Paper>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<MrcDashboardProps> = async (ctx) => {
  const page = readPageFromQuery(ctx.query);
  const pageSize = readPageSizeFromQuery(ctx.query);
  const sort = parseSort(ctx.query.sort);
  const sortStr = formatSort(sort.field, sort.dir);
  try {
    const [s, t, w, b, k, r] = await Promise.all([
      api.get('/mrc-requests/summary'),
      api.get('/mrc-requests/timeline', { params: { days: TIMELINE_DAYS } }),
      api.get('/mrc-requests/wait-distribution', { params: { days: WAIT_DAYS } }),
      api.get('/mrc-requests/bid-vs-payout', { params: { days: SCATTER_DAYS } }),
      api.get('/mrc-requests/staker-take', { params: { days: STAKER_TAKE_DAYS } }),
      api.get('/mrc-requests', {
        params: { 'page[number]': page + 1, 'page[size]': pageSize, sort: sortStr },
      }),
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
        initialRecentTotal: Number(r.data?.meta?.count ?? 0),
        initialPage: page,
        initialPageSize: pageSize,
        initialSort: sortStr,
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
        initialRecentTotal: 0,
        initialPage: page,
        initialPageSize: pageSize,
        initialSort: sortStr,
      },
    };
  }
};
