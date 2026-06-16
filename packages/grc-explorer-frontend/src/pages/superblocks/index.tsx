import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead,
  TablePagination, TableRow, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useRechartsXZoom } from '../../components/charts/useRechartsXZoom';
import { ZoomResetButton } from '../../components/charts/useXZoom';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatCompact, formatNumber } from '../../lib/format';
import { pushPaginationQuery, readPageFromQuery, readPageSizeFromQuery } from '../../lib/pagination';
import { ChartLegend } from '../../components/charts/SvgChart';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { CopyLinkButton } from '../../components/CopyLinkButton';
import { HashTrim } from '../../components/HashTrim';
import { makeRechartsTooltip } from '../../components/charts/RechartsTooltip';

interface Superblock {
  height: number;
  quorumHash: string;
  totalMagnitude: number;
  cpidCount: number;
  projectCount: number;
  /** Daemon's superblock contract m_version (1, 2, or 3 today). v3
   *  (activated at V13) carries per-project all-CPID total credit.
   *  Null when the indexer pre-dates the contract_version column;
   *  the UI hides the chip in that case rather than badging as 'v?'. */
  contractVersion: number | null;
}

interface TimelineSample {
  height: number;
  projectCount: number;
  cpidCount: number;
  totalMagnitude: number;
}

// `keyof`-pinned dataKey constants — if the field rename happens on
// the SSR shape the tooltip predicate breaks at compile time, not at
// runtime as a silently-wrong "CPIDs" label.
const TIMELINE_PROJECT_KEY: keyof TimelineSample = 'projectCount';
const TIMELINE_CPID_KEY: keyof TimelineSample = 'cpidCount';

interface SuperblocksListProps {
  initialRows: Superblock[];
  initialTotal: number;
  initialPage: number;
  initialPageSize: number;
  initialTimeline: TimelineSample[];
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 50;

export default function SuperblocksList({
  initialRows, initialTotal, initialPage, initialPageSize, initialTimeline,
}: SuperblocksListProps) {
  const router = useRouter();
  const theme = useTheme();
  const timelineZoom = useRechartsXZoom('z');
  const [rows, setRows] = useState<Superblock[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [loading, setLoading] = useState(false);

  // Themed tooltip for the timeline chart. Memoised on the two series
  // colours so a dark/light flip rebuilds it but ordinary renders don't
  // churn recharts' content identity.
  const TimelineTooltip = useMemo(() => makeRechartsTooltip((payload, label) => ({
    title: typeof label === 'number' ? `Height #${formatNumber(label)}` : undefined,
    rows: payload.map((p) => {
      const v = Number(p.value ?? 0);
      if (p.dataKey === TIMELINE_PROJECT_KEY) {
        return { label: 'Projects', value: formatNumber(v), color: p.color ?? theme.palette.primary.main };
      }
      return { label: 'CPIDs', value: formatNumber(v), color: p.color ?? theme.palette.secondary.main };
    }),
  })), [theme.palette.primary.main, theme.palette.secondary.main]);

  const page = readPageFromQuery(router.query);
  const pageSize = readPageSizeFromQuery(router.query, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE);

  // Skip the first client-side fetch — SSR already hydrated us with the
  // exact (page, pageSize) the URL asked for. Refetch only when the
  // user navigates to a different page/pageSize after mount.
  const initialKey = `${initialPage}/${initialPageSize}`;
  const lastFetchedKey = useRef(initialKey);

  useEffect(() => {
    const key = `${page}/${pageSize}`;
    if (key === lastFetchedKey.current) return;
    lastFetchedKey.current = key;
    let cancelled = false;
    setLoading(true);
    api.get('/superblocks', {
      params: { 'page[number]': page + 1, 'page[size]': pageSize },
    }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: Superblock }>;
      setRows(data.map((d) => d.attributes));
      setTotal(Number(r.data?.meta?.count ?? 0));
    }).catch(() => {
      if (cancelled) return;
      setRows([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page, pageSize]);

  const updateQuery = (next: { page?: number; pageSize?: number }) => {
    pushPaginationQuery(router, next);
  };

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs
          items={[
            RESEARCHERS_CRUMB,
            { label: 'Superblocks' },
          ]}
          trailing={<CopyLinkButton />}
        />
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Superblocks</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Superblocks are periodic snapshots of every researcher&apos;s
          magnitude and every active project&apos;s beacon, pinned into
          the chain by a single block roughly every six hours. They&apos;re
          how Gridcoin agrees on who earned what research reward without
          re-tallying BOINC stats on every block. Every claim that pays
          a researcher between superblocks references the most recent
          one. Each row below links into the full per-CPID magnitude
          table for that snapshot.
        </Typography>

        {initialTimeline.length >= 2 && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" component="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
                Quorum growth over time
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                {`${formatNumber(initialTimeline.length)} superblocks — project count (left axis), CPID count (right axis).`}
              </Typography>
              <Box sx={{ position: 'relative' }}>
              <ZoomResetButton zoom={timelineZoom} />
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={initialTimeline}
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  onMouseDown={timelineZoom.onMouseDown}
                  onMouseMove={timelineZoom.onMouseMove}
                  onMouseUp={timelineZoom.onMouseUp}
                  style={{ cursor: 'crosshair' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
                  <XAxis
                    dataKey="height"
                    type="number"
                    domain={timelineZoom.domain ?? ['dataMin', 'dataMax']}
                    allowDataOverflow
                    tickFormatter={(h: number) => formatCompact(h, 1)}
                    fontSize={11}
                  />
                  <YAxis
                    yAxisId="projects"
                    orientation="left"
                    fontSize={11}
                    allowDecimals={false}
                    tick={{ fill: theme.palette.primary.main }}
                  />
                  <YAxis
                    yAxisId="cpids"
                    orientation="right"
                    fontSize={11}
                    allowDecimals={false}
                    tickFormatter={(v: number) => formatCompact(v, 1)}
                  />
                  <Tooltip
                    cursor={{ stroke: theme.palette.divider, strokeDasharray: '3 3' }}
                    content={<TimelineTooltip />}
                  />
                  <Line
                    yAxisId="projects"
                    type="monotone"
                    dataKey={TIMELINE_PROJECT_KEY}
                    stroke={theme.palette.primary.main}
                    strokeWidth={2}
                    dot={false}
                    name="Projects"
                  />
                  <Line
                    yAxisId="cpids"
                    type="monotone"
                    dataKey={TIMELINE_CPID_KEY}
                    stroke={theme.palette.secondary.main}
                    strokeWidth={2}
                    dot={false}
                    name="CPIDs"
                  />
                  {timelineZoom.refLeft !== null && timelineZoom.refRight !== null && (
                    <ReferenceArea
                      yAxisId="projects"
                      x1={timelineZoom.refLeft}
                      x2={timelineZoom.refRight}
                      strokeOpacity={0.3}
                      fill={theme.palette.primary.main}
                      fillOpacity={0.12}
                    />
                  )}
                  {timelineZoom.marker !== null && (
                    <ReferenceLine
                      yAxisId="projects"
                      x={timelineZoom.marker}
                      stroke={theme.palette.secondary.main}
                      strokeDasharray="2 3"
                      strokeWidth={1.5}
                      ifOverflow="hidden"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              </Box>
              <Box sx={{ mt: 1 }}>
                <ChartLegend items={[
                  { label: 'Projects', color: theme.palette.primary.main },
                  { label: 'CPIDs', color: theme.palette.secondary.main },
                ]}
                />
              </Box>
            </CardContent>
          </Card>
        )}

        <Paper variant="outlined" sx={{ overflowX: 'auto', opacity: loading ? 0.6 : 1, transition: 'opacity 120ms' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Height</TableCell>
                <TableCell>Quorum</TableCell>
                <TableCell align="right">Total magnitude</TableCell>
                <TableCell align="right">CPIDs</TableCell>
                <TableCell align="right">Projects</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.height} hover>
                  <TableCell>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Link href={`/superblocks/${s.height}`} style={{ color: 'inherit' }}>{formatNumber(s.height)}</Link>
                      <ContractVersionChip version={s.contractVersion} />
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}><HashTrim text={s.quorumHash} /></TableCell>
                  <TableCell align="right">{s.totalMagnitude.toFixed(0)}</TableCell>
                  <TableCell align="right">{formatNumber(s.cpidCount)}</TableCell>
                  <TableCell align="right">{s.projectCount}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No superblocks found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_, p) => updateQuery({ page: p })}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onRowsPerPageChange={(e) => updateQuery({ page: 0, pageSize: parseInt(e.target.value, 10) })}
          />
        </Paper>
      </Stack>
    </Layout>
  );
}

// Inline contract-version chip. v3 (V13+) gets primary-coloured
// emphasis because the format carries new fields the rest of the
// explorer key off (per-project all-CPID total credit for AutoGreylist).
// v1/v2 stay neutral. Null (pre-feature row) renders no chip so the
// column doesn't fill with "v?" placeholders on the historical scroll.
function ContractVersionChip({ version }: { version: number | null }) {
  if (version === null || version <= 0) return null;
  const color: 'primary' | 'default' = version >= 3 ? 'primary' : 'default';
  const title = version >= 3
    ? 'Superblock v3 — carries per-project all-CPID total credit (V13+)'
    : `Superblock v${version}`;
  return <Chip size="small" label={`v${version}`} color={color} variant="outlined" title={title} />;
}


export const getServerSideProps: GetServerSideProps<SuperblocksListProps> = async (ctx) => {
  const page = readPageFromQuery(ctx.query);
  const pageSize = readPageSizeFromQuery(ctx.query, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE);
  try {
    const [pageRes, timelineRes] = await Promise.all([
      api.get('/superblocks', {
        params: { 'page[number]': page + 1, 'page[size]': pageSize },
      }),
      api.get('/superblocks/timeline'),
    ]);
    const data = (pageRes.data?.data ?? []) as Array<{ attributes: Superblock }>;
    const total = Number(pageRes.data?.meta?.count ?? 0);
    const initialTimeline = (timelineRes.data?.data?.attributes?.samples ?? []) as TimelineSample[];
    return {
      props: {
        initialRows: data.map((d) => d.attributes),
        initialTotal: total,
        initialPage: page,
        initialPageSize: pageSize,
        initialTimeline,
      },
    };
  } catch {
    return {
      props: {
        initialRows: [], initialTotal: 0, initialPage: page, initialPageSize: pageSize, initialTimeline: [],
      },
    };
  }
};
