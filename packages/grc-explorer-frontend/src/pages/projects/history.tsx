import {
  Box, Button, Card, CardActionArea, CardContent, Chip, Grid, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { Layout } from '../../layouts/Layout';
import {
  ChartAxes, ChartFrame, ChartFrameProvider, linearScale, niceTicks,
} from '../../components/charts/SvgChart';
import { Crumbs } from '../../components/Crumbs';
import { api } from '../../lib/api';

interface HistoryEvent {
  project: string;
  action: 'add' | 'remove' | string;
}

interface Point {
  ts: number;
  date: string;
  active: number;
  delisted: number;
  delistedToday: number;
  events: HistoryEvent[];
}

interface ProjectHistoryProps {
  points: Point[];
}

// Hoisted so the X-axis tick formatter can reuse it against
// `getUTCMonth()`. Locale-dependent date formatting caused SSR/CSR
// hydration drift on year-boundary ticks (server renders Dec 31 23:59:59
// UTC in UTC, client renders the same instant in its own TZ as Jan 1).
// UTC-anchored array lookup is timezone-invariant.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1] ?? '???'} ${y}`;
}

function formatCount(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '—';
  return Math.round(v).toLocaleString();
}

type YearViewMode = 'timeline' | 'composition';

export default function ProjectHistory({ points }: ProjectHistoryProps) {
  const router = useRouter();
  const yearGroups = useMemo(() => groupByYear(points), [points]);
  const [yearViewMode, setYearViewMode] = useState<YearViewMode>('composition');

  const selectedYear = useMemo(() => {
    const raw = router.query.year;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const n = Number(value);
    return Number.isInteger(n) && n >= 2000 && n <= 2999 ? n : null;
  }, [router.query.year]);

  const selectedPoints = useMemo(() => {
    if (selectedYear === null) return [];
    const g = yearGroups.find((x) => x.year === selectedYear);
    return g ? g.points : [];
  }, [selectedYear, yearGroups]);

  const setYear = useCallback((year: number | null) => {
    const query = { ...router.query };
    if (year === null) delete query.year;
    else query.year = String(year);
    router.push({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router]);

  const allTime = useMemo(() => {
    if (points.length === 0) return null;
    let peakActive = 0;
    let totalDelistings = 0;
    let biggestSpike = 0;
    let biggestSpikeDate: string | null = null;
    for (const p of points) {
      if (p.active > peakActive) peakActive = p.active;
      totalDelistings += p.delistedToday;
      if (p.delistedToday > biggestSpike) {
        biggestSpike = p.delistedToday;
        biggestSpikeDate = p.date;
      }
    }
    const last = points[points.length - 1];
    return {
      peakActive,
      currentActive: last.active,
      currentDelisted: last.delisted,
      totalDelistings,
      biggestSpike,
      biggestSpikeDate,
      firstDate: points[0].date,
      lastDate: last.date,
      days: points.length,
    };
  }, [points]);

  const yearStats = useMemo(() => {
    if (selectedPoints.length === 0) return null;
    let peakActive = 0;
    let delistingsThisYear = 0;
    const eventsThisYear: HistoryEvent[] = [];
    for (const p of selectedPoints) {
      if (p.active > peakActive) peakActive = p.active;
      delistingsThisYear += p.delistedToday;
      for (const e of p.events) eventsThisYear.push(e);
    }
    const last = selectedPoints[selectedPoints.length - 1];
    return {
      peakActive,
      yearEndActive: last.active,
      yearEndDelisted: last.delisted,
      delistingsThisYear,
      addsThisYear: eventsThisYear.filter((e) => e.action === 'add').length,
      events: eventsThisYear,
      days: selectedPoints.length,
    };
  }, [selectedPoints]);

  return (
    <Layout>
      <Head>
        <title>
          {selectedYear !== null
            ? `Gridcoin BOINC project lifecycle in ${selectedYear} — adds, de-listings, active count`
            : 'Gridcoin BOINC project lifecycle — every whitelist add and de-listing since genesis'}
        </title>
        <meta
          name="description"
          content={
            allTime
              ? `Gridcoin's whitelisted BOINC project count across ${allTime.days.toLocaleString()} days, with ${allTime.totalDelistings} cumulative de-listings — peak ${allTime.peakActive} active, currently ${allTime.currentActive}.`
              : 'Whole-chain Gridcoin BOINC project lifecycle history with per-year breakdown.'
          }
        />
        <link rel="canonical" href="/projects/history" />
      </Head>

      <Stack spacing={3}>
        <Crumbs
          items={selectedYear !== null
            ? [
              { label: 'Researchers', href: '/superblocks' },
              { label: 'BOINC projects', href: '/' },
              { label: 'History', href: '/projects/history' },
              { label: String(selectedYear) },
            ]
            : [
              { label: 'Researchers', href: '/superblocks' },
              { label: 'BOINC projects', href: '/' },
              { label: 'History' },
            ]}
        />
        <Box>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
            Project lifecycle history
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Whitelisted projects (cumulative) and de-listed projects (cumulative)
            across the whole chain, plus per-day spike markers when one or more
            projects were voted off the list. Greylist transitions are derived
            state and not yet plotted here — see the live <Link href="/" style={{ color: 'inherit' }}>projects board</Link> for the current greylist snapshot.
          </Typography>
        </Box>

        {selectedYear === null && allTime && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ flexWrap: 'wrap' }}
            useFlexGap
          >
            <Stat label="Days indexed" value={allTime.days.toLocaleString()} />
            <Stat label="Currently whitelisted" value={formatCount(allTime.currentActive)} />
            <Stat label="All-time peak" value={formatCount(allTime.peakActive)} />
            <Stat label="Total de-listings" value={formatCount(allTime.totalDelistings)} />
            <Stat
              label="Biggest spike"
              value={allTime.biggestSpikeDate ? `${formatCount(allTime.biggestSpike)} · ${allTime.biggestSpikeDate}` : '—'}
            />
          </Stack>
        )}

        {selectedYear !== null && yearStats && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ flexWrap: 'wrap' }}
            useFlexGap
          >
            <Stat label="Days" value={yearStats.days.toLocaleString()} />
            <Stat label="Year-end whitelisted" value={formatCount(yearStats.yearEndActive)} />
            <Stat label="Peak whitelisted" value={formatCount(yearStats.peakActive)} />
            <Stat label="Adds in year" value={formatCount(yearStats.addsThisYear)} />
            <Stat label="De-listings in year" value={formatCount(yearStats.delistingsThisYear)} />
          </Stack>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, flex: 1, minWidth: 200 }}>
                {selectedYear !== null
                  ? (yearViewMode === 'timeline'
                    ? `${selectedYear} — project timeline`
                    : `${selectedYear} — project composition`)
                  : 'Whole chain — daily project counts'}
              </Typography>
              {selectedYear !== null && (
                <ToggleButtonGroup
                  size="small"
                  value={yearViewMode}
                  exclusive
                  onChange={(_, v) => { if (v !== null) setYearViewMode(v as YearViewMode); }}
                  aria-label="year view mode"
                >
                  <ToggleButton value="composition" aria-label="composition (treemap)" sx={{ textTransform: 'none', fontSize: 12 }}>
                    Composition
                  </ToggleButton>
                  <ToggleButton value="timeline" aria-label="timeline (gantt)" sx={{ textTransform: 'none', fontSize: 12 }}>
                    Timeline
                  </ToggleButton>
                </ToggleButtonGroup>
              )}
              {selectedYear !== null && (
                <Button
                  size="small"
                  variant="text"
                  startIcon={<ArrowBackIcon />}
                  onClick={() => setYear(null)}
                >
                  Whole chain
                </Button>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {selectedYear !== null
                ? (yearViewMode === 'timeline'
                  ? 'Each row is one BOINC project. Green segments are when the project sat on the whitelist; gaps are when it was de-listed. Markers: green tick = whitelist add, red tick = de-listing. Currently-active projects sit at the top, those de-listed during the year drop to the bottom.'
                  : 'Each tile is one BOINC project, sized by how many days it spent on the whitelist this year. Green tiles are still on the whitelist at year end; gray tiles were de-listed during the year. Bigger tile = more time on the list.')
                : 'Green line: projects on the whitelist. Grey line: total de-listings to date. Red markers above the chart: days when one or more projects were voted off — hover for project names.'}
            </Typography>
            {selectedYear === null && <ChartLegend />}
            {selectedYear !== null && yearViewMode === 'timeline' ? (
              <YearGantt allPoints={points} yearPoints={selectedPoints} year={selectedYear} />
            ) : null}
            {selectedYear !== null && yearViewMode === 'composition' ? (
              <YearTreemap allPoints={points} yearPoints={selectedPoints} year={selectedYear} />
            ) : null}
            {selectedYear === null && points.length >= 2 ? (
              <ChartFrameProvider height={320}>
                {(frame) => <WholeChainChart frame={frame} points={points} />}
              </ChartFrameProvider>
            ) : null}
            {(selectedYear === null && points.length < 2) && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                No project lifecycle data yet — the indexer is still warming
                up to the first project ADD events. Restart the explorer to
                apply migration 0009 if you just deployed.
              </Typography>
            )}
          </CardContent>
        </Card>

        {selectedYear !== null && yearStats && yearStats.events.length > 0 && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
                Events in {selectedYear}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                Each row is a whitelist add or de-listing recorded in the chain.
              </Typography>
              <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell>Action</TableCell>
                      <TableCell>Project</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {selectedPoints.flatMap((p) => p.events.map((e) => (
                      <TableRow key={`${p.date}-${e.project}-${e.action}`}>
                        <TableCell>{formatDate(p.date)}</TableCell>
                        <TableCell>
                          <Chip
                            label={e.action === 'add' ? 'whitelist add' : 'de-list'}
                            size="small"
                            color={e.action === 'add' ? 'success' : 'default'}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Link href={`/projects/${encodeURIComponent(e.project)}`} style={{ color: 'inherit' }}>
                            {e.project}
                          </Link>
                        </TableCell>
                      </TableRow>
                    )))}
                  </TableBody>
                </Table>
              </Paper>
            </CardContent>
          </Card>
        )}

        {yearGroups.length > 0 && (
          <Box>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              Year by year
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              Each tile shows one calendar year of project counts, with red
              dots marking days where one or more projects were de-listed.
              Click a tile to inspect that year above.
            </Typography>
            <Grid container spacing={2}>
              {yearGroups.map((g) => (
                <Grid key={g.year} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
                  <YearTile
                    year={g.year}
                    points={g.points}
                    selected={g.year === selectedYear}
                    onSelect={() => setYear(g.year === selectedYear ? null : g.year)}
                  />
                </Grid>
              ))}
            </Grid>
          </Box>
        )}
      </Stack>
    </Layout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 160 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {label}
        </Typography>
        <Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

function ChartLegend() {
  const theme = useTheme();
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1.5, alignItems: 'center' }}>
      <LegendSwatch color={theme.palette.success.main} label="Whitelisted" />
      <LegendSwatch color={theme.palette.text.secondary} label="Cumulative de-listed" />
      <LegendSwatch color={theme.palette.error.main} label="De-listing day" />
    </Stack>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box
        sx={{
          width: 10, height: 10, borderRadius: 0.5, bgcolor: color, opacity: 0.85,
        }}
      />
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}

interface YearGroup {
  year: number;
  points: Point[];
}

function groupByYear(points: Point[]): YearGroup[] {
  const map = new Map<number, Point[]>();
  for (const p of points) {
    const y = Number(p.date.slice(0, 4));
    if (!Number.isFinite(y)) continue;
    const arr = map.get(y) ?? [];
    arr.push(p);
    map.set(y, arr);
  }
  return Array.from(map.entries())
    .map(([year, ps]) => ({ year, points: ps }))
    .sort((a, b) => a.year - b.year);
}

function maxCount(points: Point[]): number {
  let m = 1;
  for (const p of points) {
    if (p.active > m) m = p.active;
    if (p.delisted > m) m = p.delisted;
  }
  return m;
}

function buildLinePath(
  points: Point[],
  xOf: (p: Point) => number,
  yOf: (count: number) => number,
  pickValue: (p: Point) => number,
): string | null {
  if (points.length < 2) return null;
  const segs: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const x = xOf(p);
    const y = yOf(pickValue(p));
    segs.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return segs.join(' ');
}

function WholeChainChart({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();

  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return null;
    const tsMin = points[0].ts;
    const tsMax = points[points.length - 1].ts;
    const xScale = linearScale(tsMin, tsMax, 0, frame.innerWidth);
    const yMax = maxCount(points);
    const yPad = yMax * 0.05 || 1;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5, true);
    return {
      tsMin, tsMax, xScale, yScale, yTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  if (!layout || frame.width === 0) return null;

  const activePath = buildLinePath(points, (p) => layout.xScale(p.ts), (n) => layout.yScale(n), (p) => p.active);
  const delistedPath = buildLinePath(points, (p) => layout.xScale(p.ts), (n) => layout.yScale(n), (p) => p.delisted);

  const startYear = new Date(layout.tsMin * 1000).getUTCFullYear();
  const endYear = new Date(layout.tsMax * 1000).getUTCFullYear();
  const xTicks: { value: number; x: number }[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const ts = Math.floor(Date.UTC(y, 0, 1) / 1000);
    if (ts < layout.tsMin || ts > layout.tsMax) continue;
    xTicks.push({ value: ts, x: layout.xScale(ts) });
  }

  // Spike markers above the chart for de-listing days. Sized to the
  // event count so big delisting waves stand out from single events.
  const spikes = points.filter((p) => p.delistedToday > 0);

  return (
    <svg
      width="100%"
      height={frame.height}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      style={{ display: 'block' }}
    >
      <ChartAxes
        frame={frame}
        yTicks={layout.yTicks}
        xTicks={xTicks}
        yFormat={(v) => formatCount(v)}
        xFormat={(ts) => String(new Date(ts * 1000).getUTCFullYear())}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {delistedPath && (
          <path d={delistedPath} fill="none" stroke={theme.palette.text.secondary} strokeWidth={1.25} opacity={0.7} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {activePath && (
          <path d={activePath} fill="none" stroke={theme.palette.success.main} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {spikes.map((p) => (
          <circle
            key={p.date}
            cx={layout.xScale(p.ts)}
            cy={2 + Math.min(8, p.delistedToday * 1.5)}
            r={Math.min(4, 1.5 + p.delistedToday * 0.5)}
            fill={theme.palette.error.main}
            opacity={0.75}
          />
        ))}
      </g>
    </svg>
  );
}

function YearTile({
  year, points, selected, onSelect,
}: {
  year: number;
  points: Point[];
  selected: boolean;
  onSelect: () => void;
}) {
  const theme = useTheme();
  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        borderColor: selected ? theme.palette.primary.main : undefined,
        borderWidth: selected ? 2 : 1,
        m: selected ? '-1px' : 0,
        transition: 'border-color 80ms ease',
      }}
    >
      <CardActionArea onClick={onSelect} sx={{ height: '100%' }}>
        <CardContent sx={{ pb: 1.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 0.5 }}>
            <Typography
              variant="h6"
              sx={{ fontWeight: 700, color: selected ? 'primary.main' : 'text.primary' }}
            >
              {year}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {points.length}
              {' '}
              day
              {points.length === 1 ? '' : 's'}
            </Typography>
          </Stack>
          <ChartFrameProvider
            height={120}
            margin={{
              top: 6, right: 6, bottom: 18, left: 36,
            }}
          >
            {(frame) => <YearMiniChart frame={frame} points={points} />}
          </ChartFrameProvider>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function YearMiniChart({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length === 0 || frame.innerWidth <= 0) return null;
    const year = Number(points[0].date.slice(0, 4));
    const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
    const xScale = linearScale(yearStart, yearEnd, 0, frame.innerWidth);
    const yMax = maxCount(points);
    const yPad = yMax * 0.05 || 1;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 3, true);
    return {
      year, yearStart, yearEnd, xScale, yScale, yTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  if (!layout || frame.width === 0) return null;

  const activePath = buildLinePath(points, (p) => layout.xScale(p.ts), (n) => layout.yScale(n), (p) => p.active);
  const delistedPath = buildLinePath(points, (p) => layout.xScale(p.ts), (n) => layout.yScale(n), (p) => p.delisted);
  const spikes = points.filter((p) => p.delistedToday > 0);

  return (
    <svg
      width="100%"
      height={frame.height}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      <ChartAxes
        frame={frame}
        yTicks={layout.yTicks}
        xTicks={[
          { value: layout.yearStart, x: layout.xScale(layout.yearStart) },
          { value: Math.floor((layout.yearStart + layout.yearEnd) / 2), x: layout.xScale(Math.floor((layout.yearStart + layout.yearEnd) / 2)) },
          { value: layout.yearEnd, x: layout.xScale(layout.yearEnd) },
        ]}
        yFormat={(v) => formatCount(v)}
        xFormat={(ts) => MONTHS_SHORT[new Date(ts * 1000).getUTCMonth()] ?? '???'}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {delistedPath && (
          <path d={delistedPath} fill="none" stroke={theme.palette.text.secondary} strokeWidth={1} opacity={0.6} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {activePath && (
          <path d={activePath} fill="none" stroke={theme.palette.success.main} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {spikes.map((p) => (
          <circle
            key={p.date}
            cx={layout.xScale(p.ts)}
            cy={2}
            r={1.75}
            fill={theme.palette.error.main}
            opacity={0.7}
          />
        ))}
      </g>
    </svg>
  );
}

// Project-state Gantt for the year-detail view. Each project that
// touched the whitelist during the year (either active going in,
// added during, or removed during) gets its own row spanning the
// year. Green segments mark whitelist periods; gaps mark de-listed
// periods. Per-event ticks (▲ green = add, ▼ red = remove) sit
// inside each row. Hovering a row lifts a tooltip showing the
// project + the period under the cursor.
//
// Sort order: still-active-at-year-end first (alphabetical), then
// projects de-listed during the year (alphabetical). Projects added
// AND removed within the same year fall into the second group.
//
// Replaces a 2-line chart that, per the user's review, was visually
// flat-and-uninformative — counts without per-project resolution.
// This shape answers "which projects were where, when?" directly.

interface Interval {
  startDay: string;
  endDay: string;
  status: 'active' | 'delisted';
}

interface ProjectTimeline {
  name: string;
  intervals: Interval[];
  events: Array<{ date: string; action: 'add' | 'remove' | string }>;
  endStatus: 'active' | 'delisted';
}

function dateToYearFraction(date: string, year: number): number {
  const yearStartTs = Date.UTC(year, 0, 1) / 1000;
  const yearEndTs = Date.UTC(year + 1, 0, 1) / 1000 - 1;
  const dayTs = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const span = yearEndTs - yearStartTs;
  if (span <= 0) return 0;
  const f = (dayTs - yearStartTs) / span;
  return Math.max(0, Math.min(1, f));
}

function YearGantt({
  allPoints, yearPoints, year,
}: {
  allPoints: Point[];
  yearPoints: Point[];
  year: number;
}) {
  const theme = useTheme();
  const yearStartIso = `${year}-01-01`;
  const yearEndIso = `${year}-12-31`;

  const timelines = useMemo<ProjectTimeline[]>(() => {
    // Step 1: reconstruct the set of projects active going INTO the
    // selected year by walking all-time points up to (but not
    // including) the year. The /projects/history payload carries
    // every per-day cumulative count + events array since the first
    // chain event, so this is just an in-memory replay.
    const seedActive = new Set<string>();
    for (const p of allPoints) {
      if (p.date >= yearStartIso) break;
      for (const e of p.events) {
        if (e.action === 'add') seedActive.add(e.project);
        else if (e.action === 'remove') seedActive.delete(e.project);
      }
    }

    // Step 2: for each project that was active at year start OR had
    // any event during the year, walk through and emit intervals on
    // every state flip. Default end-of-year is the last in-year point
    // so a partial current year (no Dec 31) gets a sane ribbon.
    const yearProjects = new Set<string>(seedActive);
    for (const p of yearPoints) for (const e of p.events) yearProjects.add(e.project);

    const lastInYearDate = yearPoints.length > 0
      ? yearPoints[yearPoints.length - 1].date
      : yearEndIso;

    const out: ProjectTimeline[] = [];
    for (const project of Array.from(yearProjects)) {
      let status: 'active' | 'delisted' = seedActive.has(project) ? 'active' : 'delisted';
      let segStart = yearStartIso;
      const intervals: Interval[] = [];
      const events: ProjectTimeline['events'] = [];
      for (const p of yearPoints) {
        for (const e of p.events) {
          if (e.project !== project) continue;
          events.push({ date: p.date, action: e.action });
          const next: 'active' | 'delisted' = e.action === 'add' ? 'active' : 'delisted';
          if (next !== status) {
            intervals.push({ startDay: segStart, endDay: p.date, status });
            segStart = p.date;
            status = next;
          }
        }
      }
      intervals.push({ startDay: segStart, endDay: lastInYearDate, status });
      out.push({
        name: project, intervals, events, endStatus: status,
      });
    }

    // Active at year end on top, then de-listed; alphabetical within
    // each group. The "still active" cohort is what most readers care
    // about first, and a delisting in the year is a notable event so
    // those rows naturally cluster together at the bottom.
    return out.sort((a, b) => {
      if (a.endStatus !== b.endStatus) return a.endStatus === 'active' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [allPoints, yearPoints, year, yearStartIso, yearEndIso]);

  if (timelines.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No projects to plot for {year}.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      {/* Month axis. Month label sits at the START of each month's
          slot; final tick anchors at year end. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '110px 1fr', sm: '160px 1fr' },
          gap: 1,
          mb: 0.5,
          alignItems: 'center',
        }}
      >
        <Box />
        <Box sx={{ position: 'relative', height: 18 }}>
          {MONTHS_SHORT.map((m, i) => (
            <Typography
              key={m}
              variant="caption"
              color="text.secondary"
              sx={{
                position: 'absolute',
                left: `${(i / 12) * 100}%`,
                fontSize: 10,
                lineHeight: 1.4,
                transform: 'translateX(-50%)',
                opacity: 0.7,
              }}
            >
              {m}
            </Typography>
          ))}
        </Box>
      </Box>

      {/* Project rows. maxHeight + scroll keeps the chart bounded on
          dense years; rows are 22px each so 16+ rows still fit before
          the inner scroll kicks in. */}
      <Box sx={{ maxHeight: 460, overflowY: 'auto', pr: 0.5 }}>
        {timelines.map((t) => (
          <Box
            key={t.name}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '110px 1fr', sm: '160px 1fr' },
              gap: 1,
              alignItems: 'center',
              py: 0.5,
              borderBottom: 1,
              borderColor: 'divider',
              '&:last-of-type': { borderBottom: 0 },
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Link
              href={`/projects/${encodeURIComponent(t.name)}`}
              style={{ color: 'inherit', textDecoration: 'none', overflow: 'hidden' }}
            >
              <Typography
                variant="caption"
                sx={{
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'block',
                  ':hover': { textDecoration: 'underline' },
                }}
                title={t.name}
              >
                {t.name}
              </Typography>
            </Link>
            <Box
              sx={{
                position: 'relative',
                height: 14,
                bgcolor: 'action.hover',
                borderRadius: 0.5,
              }}
              title={`${t.name} · ${t.endStatus === 'active' ? 'whitelisted at year end' : 'de-listed'}`}
            >
              {t.intervals.map((iv) => {
                if (iv.status !== 'active') return null;
                const left = dateToYearFraction(iv.startDay, year);
                const right = dateToYearFraction(iv.endDay, year);
                const width = Math.max(0, right - left);
                if (width <= 0) return null;
                return (
                  <Box
                    key={`${iv.startDay}-${iv.endDay}`}
                    sx={{
                      position: 'absolute',
                      left: `${left * 100}%`,
                      width: `${width * 100}%`,
                      top: 0,
                      bottom: 0,
                      bgcolor: theme.palette.success.main,
                      opacity: 0.55,
                      borderRadius: 0.5,
                    }}
                  />
                );
              })}
              {t.events.map((e) => {
                const x = dateToYearFraction(e.date, year);
                const colour = e.action === 'add' ? theme.palette.success.main : theme.palette.error.main;
                return (
                  <Box
                    key={`${e.date}-${e.action}`}
                    sx={{
                      position: 'absolute',
                      left: `calc(${x * 100}% - 1px)`,
                      top: -2,
                      bottom: -2,
                      width: 2,
                      bgcolor: colour,
                    }}
                    title={`${formatDate(e.date)} · ${e.action === 'add' ? 'whitelist add' : 'de-list'}`}
                  />
                );
              })}
            </Box>
          </Box>
        ))}
      </Box>

      {/* Compact legend just below the chart so the colour vocabulary
          is right where readers look after scanning the rows. */}
      <Stack direction="row" spacing={2} sx={{ mt: 1.5, alignItems: 'center' }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{
            width: 16, height: 8, bgcolor: theme.palette.success.main, opacity: 0.55, borderRadius: 0.5,
          }}
          />
          <Typography variant="caption" color="text.secondary">whitelisted</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{
            width: 2, height: 12, bgcolor: theme.palette.success.main,
          }}
          />
          <Typography variant="caption" color="text.secondary">add</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{
            width: 2, height: 12, bgcolor: theme.palette.error.main,
          }}
          />
          <Typography variant="caption" color="text.secondary">de-list</Typography>
        </Stack>
      </Stack>
    </Box>
  );
}

// Treemap-as-composition for the year-detail view. Each tile is a
// project, sized roughly proportional to how many days that project
// spent on the whitelist during the selected year. Sister view to
// YearGantt: same data, different question.
//   • Gantt answers WHEN — which days each project sat on the list.
//   • Treemap answers HOW MUCH — which projects held the list for the
//     biggest share of the year.
//
// Layout: a strip-pack ("squarified-lite") algorithm. Items sort
// descending by weight; rows fill greedily, switching rows when adding
// the next item would degrade the row's worst aspect ratio. Within
// each row, items take width proportional to their weight; row height
// scales so the row's total area matches the row's total weight share
// of the chart area. Result: bigger tiles cluster top-left, smaller
// tiles toward bottom-right, with reasonably square aspect on each
// item. Not a true squarified treemap (would buy us nothing visible
// at this data scale) but close enough.
//
// Color: success.main at 0.55 opacity for projects active at year
// end, neutral surface for projects de-listed during the year. Tile
// labels truncate gracefully when the tile is too small to fit.

interface TreemapStat {
  name: string;
  activeDays: number;
  endStatus: 'active' | 'delisted';
}

interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  stat: TreemapStat;
}

function packStrips(stats: TreemapStat[], width: number, height: number): TreemapRect[] {
  const items = stats
    .filter((s) => s.activeDays > 0)
    .slice()
    .sort((a, b) => b.activeDays - a.activeDays);
  if (items.length === 0 || width <= 0 || height <= 0) return [];

  const rects: TreemapRect[] = [];
  let cursorY = 0;
  let remainingHeight = height;
  let i = 0;

  while (i < items.length && remainingHeight > 0.5) {
    const remaining = items.slice(i);
    const remainingWeight = remaining.reduce((s, it) => s + it.activeDays, 0);
    if (remainingWeight <= 0) break;

    // Greedily extend the current row until the worst aspect ratio
    // would get worse. Aspect ratio per item = max(w/h, h/w); lower
    // is more square. Adding more items shrinks each but also shrinks
    // the row's height; the trade-off has a sweet spot per row.
    const row: TreemapStat[] = [];
    let rowWeight = 0;
    let bestWorst = Infinity;

    for (const item of remaining) {
      const newRow = [...row, item];
      const newWeight = rowWeight + item.activeDays;
      const newRowArea = (newWeight / remainingWeight) * (width * remainingHeight);
      const newRowHeight = newRowArea / width;
      let worst = 0;
      for (const x of newRow) {
        const xWidth = (x.activeDays / newWeight) * width;
        const xHeight = newRowHeight;
        if (xWidth <= 0 || xHeight <= 0) continue;
        const ratio = Math.max(xWidth / xHeight, xHeight / xWidth);
        if (ratio > worst) worst = ratio;
      }
      if (worst <= bestWorst || newRow.length === 1) {
        row.push(item);
        rowWeight = newWeight;
        bestWorst = worst;
      } else {
        break;
      }
    }

    if (row.length === 0) break;

    const rowArea = (rowWeight / remainingWeight) * (width * remainingHeight);
    const rowHeight = Math.max(0, Math.min(remainingHeight, rowArea / width));
    let cursorX = 0;
    for (const item of row) {
      const itemWidth = (item.activeDays / rowWeight) * width;
      rects.push({
        x: cursorX, y: cursorY, w: itemWidth, h: rowHeight, stat: item,
      });
      cursorX += itemWidth;
    }
    cursorY += rowHeight;
    remainingHeight -= rowHeight;
    i += row.length;
  }

  return rects;
}

function YearTreemap({
  allPoints, yearPoints, year,
}: {
  allPoints: Point[];
  yearPoints: Point[];
  year: number;
}) {
  const theme = useTheme();
  const yearStartIso = `${year}-01-01`;

  const stats = useMemo<TreemapStat[]>(() => {
    // Same seed-state replay as YearGantt: walk all-time points up to
    // (but excluding) the selected year to reconstruct who's whitelisted
    // going into Jan 1. This lets a project active since 2018 with no
    // 2024 events still register as "active all of 2024".
    const seedActive = new Set<string>();
    for (const p of allPoints) {
      if (p.date >= yearStartIso) break;
      for (const e of p.events) {
        if (e.action === 'add') seedActive.add(e.project);
        else if (e.action === 'remove') seedActive.delete(e.project);
      }
    }

    const yearProjects = new Set<string>(seedActive);
    for (const p of yearPoints) for (const e of p.events) yearProjects.add(e.project);

    const out: TreemapStat[] = [];
    for (const project of Array.from(yearProjects)) {
      let status: 'active' | 'delisted' = seedActive.has(project) ? 'active' : 'delisted';
      let activeDays = 0;
      let endStatus: 'active' | 'delisted' = status;
      for (const p of yearPoints) {
        for (const e of p.events) {
          if (e.project !== project) continue;
          status = e.action === 'add' ? 'active' : 'delisted';
        }
        if (status === 'active') activeDays += 1;
        endStatus = status;
      }
      if (activeDays > 0) out.push({ name: project, activeDays, endStatus });
    }
    return out.sort((a, b) => b.activeDays - a.activeDays);
  }, [allPoints, yearPoints, year, yearStartIso]);

  const totalDaysInYear = yearPoints.length || 365;

  return (
    <ChartFrameProvider height={420} margin={{
      top: 0, right: 0, bottom: 0, left: 0,
    }}
    >
      {(frame) => {
        if (stats.length === 0 || frame.width === 0) {
          return (
            <Box sx={{ py: 4, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                No projects to plot for {year}.
              </Typography>
            </Box>
          );
        }
        const rects = packStrips(stats, frame.width, frame.innerHeight);
        return (
          <Box sx={{ position: 'relative', width: '100%', height: frame.innerHeight }}>
            {rects.map((r) => {
              const pct = Math.round((r.stat.activeDays / totalDaysInYear) * 100);
              const isActive = r.stat.endStatus === 'active';
              const showLabel = r.w >= 60 && r.h >= 28;
              const showSub = r.w >= 90 && r.h >= 50;
              return (
                <Link
                  key={r.stat.name}
                  href={`/projects/${encodeURIComponent(r.stat.name)}`}
                  style={{
                    position: 'absolute',
                    left: r.x,
                    top: r.y,
                    width: r.w,
                    height: r.h,
                    color: 'inherit',
                    textDecoration: 'none',
                    boxSizing: 'border-box',
                  }}
                  title={`${r.stat.name} · ${r.stat.activeDays} days · ${pct}%`}
                >
                  <Box
                    sx={{
                      width: '100%',
                      height: '100%',
                      bgcolor: isActive ? theme.palette.success.main : theme.palette.action.hover,
                      opacity: isActive ? 0.7 : 1,
                      border: 1,
                      borderColor: 'background.paper',
                      boxSizing: 'border-box',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      px: 0.75,
                      py: 0.5,
                      overflow: 'hidden',
                      transition: 'filter 100ms ease',
                      ':hover': { filter: 'brightness(1.1)' },
                    }}
                  >
                    {showLabel && (
                      <Typography
                        variant="caption"
                        sx={{
                          fontWeight: 700,
                          fontSize: 12,
                          lineHeight: 1.25,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          color: isActive ? 'success.contrastText' : 'text.primary',
                        }}
                      >
                        {r.stat.name}
                      </Typography>
                    )}
                    {showSub && (
                      <Typography
                        variant="caption"
                        sx={{
                          fontSize: 10,
                          lineHeight: 1.4,
                          opacity: 0.85,
                          color: isActive ? 'success.contrastText' : 'text.secondary',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {`${r.stat.activeDays}d · ${pct}%`}
                      </Typography>
                    )}
                  </Box>
                </Link>
              );
            })}
          </Box>
        );
      }}
    </ChartFrameProvider>
  );
}

export const getServerSideProps: GetServerSideProps<ProjectHistoryProps> = async () => {
  try {
    const r = await api.get('/projects/history', { params: { range: 'all' } });
    const points = (r.data?.data?.attributes?.points ?? []) as Point[];
    return { props: { points } };
  } catch {
    return { props: { points: [] } };
  }
};
