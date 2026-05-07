import {
  Box, Button, Card, CardActionArea, CardContent, Grid, Stack, Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  useCallback, useMemo, useRef, useState,
} from 'react';
import { Layout } from '../../layouts/Layout';
import {
  ChartAxes, ChartFrame, ChartFrameProvider, ChartTooltip, linearScale, niceTicks,
} from '../../components/charts/SvgChart';
import { Crumbs } from '../../components/Crumbs';
import { api } from '../../lib/api';

interface Point {
  ts: number;
  date: string;
  min: string;
  max: string;
  open: string;
  close: string;
  avg: number;
  samples: number;
}

interface DifficultyHistoryProps {
  points: Point[];
}

// Difficulty values stretch over many orders of magnitude across
// Gridcoin's lifetime (early PoW phase mid-single digits → modern PoS
// thousands). A linear axis collapses the long tail onto the X axis
// and erases everything pre-2017; log10 keeps every era legible at
// once. Guards against zero/negative inputs (shouldn't happen on real
// data but the chart should be honest if it does).
function safeLog10(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.log10(v);
}

function formatDifficulty(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}k`;
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

// Hoisted so the X-axis tick formatter can reuse it against
// `getUTCMonth()`. Locale-dependent date formatting (the previous
// `toLocaleString('en', { month: 'short' })` shape) caused SSR/CSR
// hydration drift on the year-end tick: server renders Dec 31 23:59:59 UTC
// in UTC ("Dec"), client renders the same instant in its own TZ ("Jan" in
// any positive offset). UTC-anchored array lookup is timezone-invariant.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(date: string): string {
  // YYYY-MM-DD → "12 Mar 2024" without spinning up a Date object per
  // tooltip frame (mouse-move can fire 60×/s).
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1] ?? '???'} ${y}`;
}

export default function DifficultyHistory({ points }: DifficultyHistoryProps) {
  const router = useRouter();
  const yearGroups = useMemo(() => groupByYear(points), [points]);

  // ?year=YYYY drives selection. Pure URL state — direct links work,
  // browser back/forward Just Works, and the SSR payload is the same
  // whole-chain dataset for every URL (we slice client-side on the
  // selected year, so no extra fetch and no re-flicker).
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
    // shallow: getServerSideProps is whole-chain payload; no refetch.
    router.push({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router]);

  const allTime = useMemo(() => {
    if (points.length === 0) return null;
    let allMin = Number.POSITIVE_INFINITY;
    let allMax = 0;
    let lastAvg = 0;
    for (const p of points) {
      const mn = Number(p.min);
      const mx = Number(p.max);
      if (Number.isFinite(mn) && mn < allMin && mn > 0) allMin = mn;
      if (Number.isFinite(mx) && mx > allMax) allMax = mx;
      lastAvg = p.avg;
    }
    return {
      min: allMin === Number.POSITIVE_INFINITY ? 0 : allMin,
      max: allMax,
      latest: lastAvg,
      firstDate: points[0].date,
      lastDate: points[points.length - 1].date,
      days: points.length,
    };
  }, [points]);

  const yearStats = useMemo(() => {
    if (selectedPoints.length === 0) return null;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = 0;
    let avgSum = 0;
    let avgN = 0;
    let blockSum = 0;
    for (const p of selectedPoints) {
      const mn = Number(p.min);
      const mx = Number(p.max);
      if (Number.isFinite(mn) && mn < yMin) yMin = mn;
      if (Number.isFinite(mx) && mx > yMax) yMax = mx;
      if (Number.isFinite(p.avg)) { avgSum += p.avg; avgN += 1; }
      blockSum += p.samples;
    }
    return {
      min: yMin === Number.POSITIVE_INFINITY ? 0 : yMin,
      max: yMax,
      avg: avgN > 0 ? avgSum / avgN : 0,
      days: selectedPoints.length,
      blocks: blockSum,
    };
  }, [selectedPoints]);

  return (
    <Layout>
      <Head>
        <title>
          {selectedYear !== null
            ? `Gridcoin difficulty in ${selectedYear} — daily min, max, average`
            : 'Gridcoin difficulty history — every day since genesis'}
        </title>
        <meta
          name="description"
          content={
            allTime
              ? `Daily Gridcoin network difficulty from ${allTime.firstDate} to ${allTime.lastDate}: ${allTime.days.toLocaleString()} days, peak ${formatDifficulty(allTime.max)}, current ${formatDifficulty(allTime.latest)}. Whole-chain log-scale chart and per-year detail.`
              : 'Whole-chain Gridcoin network difficulty history with per-year breakdown. Daily min, max, and average sampled from every block since genesis.'
          }
        />
        {/* Always canonicalise to the bare path so ?year=… variants
            don't split crawl rank — the year detail is a slice of the
            same data, not a separate document. */}
        <link rel="canonical" href="/network/difficulty" />
      </Head>

      <Stack spacing={3}>
        <Crumbs
          items={selectedYear !== null
            ? [
              { label: 'Researchers', href: '/superblocks' },
              { label: 'Difficulty', href: '/network/difficulty' },
              { label: String(selectedYear) },
            ]
            : [
              { label: 'Researchers', href: '/superblocks' },
              { label: 'Difficulty' },
            ]}
        />
        <Box>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
            Difficulty history
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Daily network difficulty across Gridcoin&apos;s entire chain history.
            Each point is the average of every block mined that day; minimum
            and maximum are tracked separately for the per-year view.
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
            <Stat label="Earliest" value={allTime.firstDate} />
            <Stat label="Latest" value={allTime.lastDate} />
            <Stat label="All-time peak" value={formatDifficulty(allTime.max)} />
            <Stat label="All-time low" value={formatDifficulty(allTime.min)} />
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
            <Stat label="Blocks" value={yearStats.blocks.toLocaleString()} />
            <Stat label="Year low" value={formatDifficulty(yearStats.min)} />
            <Stat label="Year peak" value={formatDifficulty(yearStats.max)} />
            <Stat label="Year average" value={formatDifficulty(yearStats.avg)} />
          </Stack>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, flex: 1 }}>
                {selectedYear !== null ? `${selectedYear} — daily min, max, average` : 'Whole chain — daily average'}
              </Typography>
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
                ? 'Linear Y axis. The shaded ribbon is the daily min↔max range; the line is the daily average. Hover for exact values.'
                : 'Log-scale Y axis. The early-PoW years (2013–2014) and modern PoS-era difficulty differ by orders of magnitude; a linear scale would erase one or the other.'}
            </Typography>
            {selectedYear !== null && selectedPoints.length >= 2 ? (
              <ChartFrameProvider height={380}>
                {(frame) => <YearDetailChart frame={frame} points={selectedPoints} year={selectedYear} />}
              </ChartFrameProvider>
            ) : null}
            {selectedYear === null && points.length >= 2 ? (
              <ChartFrameProvider height={320}>
                {(frame) => <WholeChainChart frame={frame} points={points} />}
              </ChartFrameProvider>
            ) : null}
            {(selectedYear === null && points.length < 2) && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                No difficulty data yet — the indexer is still warming up.
              </Typography>
            )}
            {(selectedYear !== null && selectedPoints.length < 2) && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                {`No data for ${selectedYear} — pick another year below.`}
              </Typography>
            )}
          </CardContent>
        </Card>

        {yearGroups.length > 0 && (
          <Box>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              Year by year
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              Each tile shows daily min, max (shaded ribbon), and average
              (line) for one calendar year. Click a tile to inspect that
              year above; click again or use Whole chain to back out.
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

function WholeChainChart({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();

  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) {
      return null;
    }
    const tsMin = points[0].ts;
    const tsMax = points[points.length - 1].ts;
    const xScale = linearScale(tsMin, tsMax, 0, frame.innerWidth);
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = 0;
    for (const p of points) {
      const a = p.avg;
      const mn = Number(p.min);
      const mx = Number(p.max);
      if (Number.isFinite(a) && a > 0 && a < yMin) yMin = a;
      if (Number.isFinite(mn) && mn > 0 && mn < yMin) yMin = mn;
      if (Number.isFinite(mx) && mx > yMax) yMax = mx;
    }
    if (yMin === Number.POSITIVE_INFINITY) yMin = 1e-3;
    if (yMax === 0) yMax = 1;
    const logMin = Math.floor(safeLog10(yMin));
    const logMax = Math.ceil(safeLog10(yMax));
    const yScale = linearScale(logMin, logMax, frame.innerHeight, 0);
    return {
      tsMin, tsMax, xScale, yScale, logMin, logMax,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const path = useMemo(() => {
    if (!layout || points.length < 2) return null;
    const segs: string[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const x = layout.xScale(p.ts);
      const y = layout.yScale(safeLog10(p.avg));
      segs.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return segs.join(' ');
  }, [layout, points]);

  if (!layout || frame.width === 0) return null;

  // Year ticks across the visible window — easier to scan than
  // arbitrary date stamps. Build from the first/last year present.
  const startYear = new Date(layout.tsMin * 1000).getUTCFullYear();
  const endYear = new Date(layout.tsMax * 1000).getUTCFullYear();
  const xTicks: { value: number; x: number }[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const ts = Math.floor(Date.UTC(y, 0, 1) / 1000);
    if (ts < layout.tsMin || ts > layout.tsMax) continue;
    xTicks.push({ value: ts, x: layout.xScale(ts) });
  }

  const yTicks: number[] = [];
  for (let exp = layout.logMin; exp <= layout.logMax; exp += 1) yTicks.push(exp);

  return (
    <svg
      width="100%"
      height={frame.height}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      style={{ display: 'block' }}
    >
      <ChartAxes
        frame={frame}
        yTicks={yTicks}
        xTicks={xTicks}
        yFormat={(v) => formatDifficulty(10 ** v)}
        xFormat={(ts) => String(new Date(ts * 1000).getUTCFullYear())}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {path && (
          <path
            d={path}
            fill="none"
            stroke={theme.palette.primary.main}
            strokeWidth={1.5}
          />
        )}
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
        // Compensate the +1px border so the tile doesn't visually jump
        // by 2 pixels in either dimension when it gets selected.
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
            {(frame) => <YearChart frame={frame} points={points} />}
          </ChartFrameProvider>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function YearChart({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length === 0 || frame.innerWidth <= 0) return null;
    // Anchor X axis to the calendar year so partial years (current,
    // 2013) don't stretch a few days across the full tile width — a
    // visual lie about how long the year was.
    const year = Number(points[0].date.slice(0, 4));
    const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
    const xScale = linearScale(yearStart, yearEnd, 0, frame.innerWidth);
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = 0;
    for (const p of points) {
      const mn = Number(p.min);
      const mx = Number(p.max);
      if (Number.isFinite(mn) && mn < yMin) yMin = mn;
      if (Number.isFinite(mx) && mx > yMax) yMax = mx;
    }
    if (yMin === Number.POSITIVE_INFINITY) yMin = 0;
    if (yMax === 0) yMax = 1;
    // Per-year linear axis (per-year y-scaling makes quiet years
    // legible). Pad ~5% so the ribbon doesn't kiss the frame edges.
    const yPad = (yMax - yMin) * 0.05 || 1;
    const yScale = linearScale(yMin - yPad, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(yMin - yPad, yMax + yPad, 3);
    return {
      year, yearStart, yearEnd, xScale, yScale, yTicks, yMin, yMax,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const paths = useMemo(() => {
    if (!layout || points.length < 2) return null;
    const top: string[] = [];
    const bot: string[] = [];
    const avg: string[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const x = layout.xScale(p.ts);
      const yMax = layout.yScale(Number(p.max));
      const yMin = layout.yScale(Number(p.min));
      const yAvg = layout.yScale(p.avg);
      top.push(`${x.toFixed(1)},${yMax.toFixed(1)}`);
      bot.unshift(`${x.toFixed(1)},${yMin.toFixed(1)}`);
      avg.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yAvg.toFixed(1)}`);
    }
    const ribbon = `M${top[0]} L${top.slice(1).join(' L')} L${bot.join(' L')} Z`;
    return { ribbon, avg: avg.join(' ') };
  }, [layout, points]);

  if (!layout || frame.width === 0) return null;

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
        yFormat={(v) => formatDifficulty(v)}
        xFormat={(ts) => {
          const d = new Date(ts * 1000);
          return MONTHS_SHORT[d.getUTCMonth()] ?? '???';
        }}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {paths && (
          <>
            <path
              d={paths.ribbon}
              fill={theme.palette.primary.main}
              fillOpacity={0.18}
              stroke="none"
            />
            <path
              d={paths.avg}
              fill="none"
              stroke={theme.palette.primary.main}
              strokeWidth={1.25}
            />
          </>
        )}
      </g>
    </svg>
  );
}

function YearDetailChart({
  frame, points, year,
}: {
  frame: ChartFrame; points: Point[]; year: number;
}) {
  const theme = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return null;
    // Anchor X to the full calendar year (not just min/max of points)
    // so partial years stay visually proportional.
    const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
    const xScale = linearScale(yearStart, yearEnd, 0, frame.innerWidth);
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = 0;
    for (const p of points) {
      const mn = Number(p.min);
      const mx = Number(p.max);
      if (Number.isFinite(mn) && mn < yMin) yMin = mn;
      if (Number.isFinite(mx) && mx > yMax) yMax = mx;
    }
    if (yMin === Number.POSITIVE_INFINITY) yMin = 0;
    if (yMax === 0) yMax = 1;
    const yPad = (yMax - yMin) * 0.05 || 1;
    const yScale = linearScale(yMin - yPad, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(yMin - yPad, yMax + yPad, 5);
    // X gridlines at month starts. 12 ticks fit a chart of this size
    // without label collision.
    const xTicks: { value: number; x: number }[] = [];
    for (let m = 0; m < 12; m += 1) {
      const ts = Math.floor(Date.UTC(year, m, 1) / 1000);
      xTicks.push({ value: ts, x: xScale(ts) });
    }
    return {
      yearStart, yearEnd, xScale, yScale, yTicks, xTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight, year]);

  const paths = useMemo(() => {
    if (!layout || points.length < 2) return null;
    const top: string[] = [];
    const bot: string[] = [];
    const avg: string[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const x = layout.xScale(p.ts);
      const yHigh = layout.yScale(Number(p.max));
      const yLow = layout.yScale(Number(p.min));
      const yAvg = layout.yScale(p.avg);
      top.push(`${x.toFixed(1)},${yHigh.toFixed(1)}`);
      bot.unshift(`${x.toFixed(1)},${yLow.toFixed(1)}`);
      avg.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yAvg.toFixed(1)}`);
    }
    const ribbon = `M${top[0]} L${top.slice(1).join(' L')} L${bot.join(' L')} Z`;
    return { ribbon, avg: avg.join(' ') };
  }, [layout, points]);

  // Map a mouse X position to the nearest data point. Linear scan over
  // ~365 points is essentially free per move event; binary search is
  // overkill at this size and keeps the code readable.
  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * frame.width - frame.margin.left;
    if (localX < 0 || localX > frame.innerWidth) {
      setHoverIdx(null);
      return;
    }
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const px = layout.xScale(points[i].ts);
      const d = Math.abs(px - localX);
      if (d < best) { best = d; nearest = i; }
    }
    setHoverIdx(nearest);
  };

  if (!layout || frame.width === 0) return null;

  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverX = hover ? layout.xScale(hover.ts) : 0;

  return (
    <Box sx={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        width="100%"
        height={frame.height}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        style={{ display: 'block' }}
      >
        <ChartAxes
          frame={frame}
          yTicks={layout.yTicks}
          xTicks={layout.xTicks}
          yFormat={(v) => formatDifficulty(v)}
          xFormat={(ts) => {
            const d = new Date(ts * 1000);
            return MONTHS_SHORT[d.getUTCMonth()] ?? '???';
          }}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          {paths && (
            <>
              <path
                d={paths.ribbon}
                fill={theme.palette.primary.main}
                fillOpacity={0.18}
                stroke="none"
              />
              <path
                d={paths.avg}
                fill="none"
                stroke={theme.palette.primary.main}
                strokeWidth={1.5}
              />
            </>
          )}
          {hover && (
            <>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={0}
                y2={frame.innerHeight}
                stroke={theme.palette.text.secondary}
                strokeDasharray="3 3"
                opacity={0.5}
              />
              <circle
                cx={hoverX}
                cy={layout.yScale(hover.avg)}
                r={3.5}
                fill={theme.palette.primary.main}
              />
            </>
          )}
        </g>
      </svg>
      {hover && (
        <ChartTooltip
          visible
          x={frame.margin.left + hoverX}
          y={frame.margin.top}
          content={(
            <Box sx={{ minWidth: 160 }}>
              <Typography
                variant="caption"
                sx={{ display: 'block', fontWeight: 700, mb: 0.5 }}
              >
                {formatDate(hover.date)}
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <TooltipNum label="Low" value={formatDifficulty(Number(hover.min))} />
                <TooltipNum label="Avg" value={formatDifficulty(hover.avg)} />
                <TooltipNum label="High" value={formatDifficulty(Number(hover.max))} />
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {`${hover.samples} block${hover.samples === 1 ? '' : 's'} mined`}
              </Typography>
            </Box>
          )}
        />
      )}
    </Box>
  );
}

function TooltipNum({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.1 }}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          display: 'block', fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<DifficultyHistoryProps> = async () => {
  try {
    const r = await api.get('/network/difficulty', { params: { range: 'all' } });
    const points = (r.data?.data?.attributes?.points ?? []) as Point[];
    return { props: { points } };
  } catch {
    return { props: { points: [] } };
  }
};
