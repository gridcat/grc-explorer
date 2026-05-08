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
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { api } from '../../lib/api';

interface Point {
  ts: number;
  date: string;
  researchers: number;
  investors: number;
  total: number;
  mintTotal: string;
  blocks: number;
}

interface StakersHistoryProps {
  points: Point[];
}

// Halford → GRC. mintTotal arrives as a Decimal-safe string from the API
// (UInt64 sums can punch through 2^53), but per-day mint values are far
// below that ceiling, so Number() round-trips safely on the chart side.
const HALFORD_PER_GRC = 100_000_000;

function halfordToGrc(s: string | number): number {
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return 0;
  return n / HALFORD_PER_GRC;
}

// Compact SI-prefix formatter capped at trillions. Beyond 1e15 we fall
// back to a clean 2-significant-digit exponential ("1.04e+18") rather
// than letting toFixed emit a 15-digit mantissa welded to a unit suffix
// ("1.036342615170709e+78M"). Honest about extreme values without
// pretending they fit a thousands/millions/billions narrative.
function formatCompact(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e15 || (abs > 0 && abs < 1e-3)) {
    // Two-significant-digit exponential: "1.0e+84", "1.7e-9".
    return `${sign}${abs.toExponential(1)}`;
  }
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(decimals)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e4) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  if (abs >= 1) return `${sign}${Math.round(abs).toLocaleString()}`;
  return `${sign}${abs.toFixed(decimals)}`;
}

function formatCount(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '—';
  return formatCompact(v, 2);
}

function formatGrc(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  return `${formatCompact(v, 2)} GRC`;
}

// Hoisted out of formatDate so the X-axis tick formatter can reuse it
// against `getUTCMonth()`. Locale-dependent date formatting (the previous
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

export default function StakersHistory({ points: rawPoints }: StakersHistoryProps) {
  const router = useRouter();
  // Belt-and-braces against the API ever shipping the count fields as
  // JSON strings (CH ships UInt64 as string by default, and the route
  // is meant to coerce — but if a future change regresses that, doing
  // `+= p.total` on a string concatenates instead of adds and the
  // chart silently flatlines). Coerce once at the boundary; arithmetic
  // downstream stays simple.
  const points = useMemo<Point[]>(() => rawPoints.map((p) => ({
    ts: Number(p.ts),
    date: p.date,
    researchers: Number(p.researchers),
    investors: Number(p.investors),
    total: Number(p.total),
    mintTotal: String(p.mintTotal),
    blocks: Number(p.blocks),
  })), [rawPoints]);
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
    router.push({ pathname: router.pathname, query }, undefined, { shallow: true });
  }, [router]);

  const allTime = useMemo(() => {
    if (points.length === 0) return null;
    let peak = 0;
    let last = points[points.length - 1];
    // 30-day rolling tail for the "GRC / staker" tile so single-day
    // outliers (e.g. a quiet Saturday with 80 stakers) don't dominate
    // the headline number.
    const tail = points.slice(-30);
    let mintTail = 0;
    let stakerTail = 0;
    for (const p of points) if (p.total > peak) peak = p.total;
    for (const p of tail) {
      mintTail += halfordToGrc(p.mintTotal);
      stakerTail += p.total;
    }
    return {
      peak,
      latest: last.total,
      grcPerStaker: stakerTail > 0 ? mintTail / stakerTail : 0,
      firstDate: points[0].date,
      lastDate: last.date,
      days: points.length,
    };
  }, [points]);

  const yearStats = useMemo(() => {
    if (selectedPoints.length === 0) return null;
    let peak = 0;
    let rSum = 0;
    let iSum = 0;
    let blockSum = 0;
    for (const p of selectedPoints) {
      if (p.total > peak) peak = p.total;
      rSum += p.researchers;
      iSum += p.investors;
      blockSum += p.blocks;
    }
    const n = selectedPoints.length;
    return {
      peak,
      avgResearchers: n > 0 ? rSum / n : 0,
      avgInvestors: n > 0 ? iSum / n : 0,
      days: n,
      blocks: blockSum,
    };
  }, [selectedPoints]);

  return (
    <Layout>
      <Head>
        <title>
          {selectedYear !== null
            ? `Gridcoin active stakers in ${selectedYear} — researchers vs investors`
            : 'Gridcoin active stakers — every day since the PoS transition'}
        </title>
        <meta
          name="description"
          content={
            allTime
              ? `Daily Gridcoin active-staker count from ${allTime.firstDate} to ${allTime.lastDate}: ${allTime.days.toLocaleString()} days, all-time peak ${formatCount(allTime.peak)}, current ${formatCount(allTime.latest)}. Researcher (CPID-bearing) vs investor (no CPID) decomposition with per-year breakdown.`
              : 'Whole-chain Gridcoin active-staker history with per-year breakdown. Researcher vs investor decomposition sampled from every PoS block since genesis.'
          }
        />
        {/* Always canonicalise to the bare path so ?year=… variants
            don't split crawl rank — the year detail is a slice of the
            same data, not a separate document. */}
        <link rel="canonical" href="/network/stakers" />
      </Head>

      <Stack spacing={3}>
        <Crumbs
          items={selectedYear !== null
            ? [
              RESEARCHERS_CRUMB,
              { label: 'Active stakers', href: '/network/stakers' },
              { label: String(selectedYear) },
            ]
            : [
              RESEARCHERS_CRUMB,
              { label: 'Active stakers' },
            ]}
        />
        <Box>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
            Active stakers
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Distinct addresses that produced a PoS block each day, split
            into researcher (CPID-bearing) and investor (no CPID) participants.
            Each tile is a calendar year of daily counts; click one to
            inspect that year in detail.
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
            <Stat label="All-time peak" value={formatCount(allTime.peak)} />
            <Stat label="GRC / staker (30d)" value={formatGrc(allTime.grcPerStaker)} />
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
            <Stat label="PoS blocks" value={yearStats.blocks.toLocaleString()} />
            <Stat label="Year peak" value={formatCount(yearStats.peak)} />
            <Stat label="Avg researchers" value={formatCount(yearStats.avgResearchers)} />
            <Stat label="Avg investors" value={formatCount(yearStats.avgInvestors)} />
          </Stack>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, flex: 1 }}>
                {selectedYear !== null ? `${selectedYear} — daily researchers + investors` : 'Whole chain — daily active stakers'}
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
                ? 'Stacked area: researchers on the bottom, investors on top — the upper edge is the day\'s total active stakers. Hover for exact counts and the GRC minted that day.'
                : 'Linear Y axis. Stacked area decomposes the daily total into researcher (CPID-bearing) and investor (no CPID) stakers; the upper edge is total participation.'}
            </Typography>
            <ChartLegend />
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
                No staker data yet — the indexer is still warming up.
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
              Each tile shows the daily researcher / investor stack for one
              calendar year. Click a tile to inspect that year above; click
              again or use Whole chain to back out.
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
      <LegendSwatch color={theme.palette.primary.main} label="Researchers" />
      <LegendSwatch color={theme.palette.secondary.main} label="Investors" />
    </Stack>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <Box
        sx={{
          width: 10, height: 10, borderRadius: 0.5, bgcolor: color, opacity: 0.7,
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

// Stacked-area path builder shared across the three chart variants.
// `top` walks the upper edge (researchers + investors) left→right; `mid`
// walks the researcher/investor boundary; `bot` walks the X-axis baseline
// right→left so the closed polygons render as filled bands. Coordinates
// are pre-scaled by the caller — this function only does the SVG wiring.
function buildStackPaths(
  points: Point[],
  xOf: (p: Point) => number,
  yOf: (count: number) => number,
  baseline: number,
): { researcherArea: string; investorArea: string; topLine: string } | null {
  if (points.length < 2) return null;
  const upper: string[] = [];
  const mid: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const x = xOf(p);
    upper.push(`${x.toFixed(1)},${yOf(p.researchers + p.investors).toFixed(1)}`);
    mid.push(`${x.toFixed(1)},${yOf(p.researchers).toFixed(1)}`);
  }
  const xFirst = xOf(points[0]);
  const xLast = xOf(points[points.length - 1]);
  const researcherArea = `M${xFirst.toFixed(1)},${baseline.toFixed(1)} L${mid.join(' L')} L${xLast.toFixed(1)},${baseline.toFixed(1)} Z`;
  const investorArea = `M${mid[0]} L${mid.slice(1).join(' L')} L${upper.slice().reverse().join(' L')} Z`;
  const topLine = `M${upper[0]} L${upper.slice(1).join(' L')}`;
  return { researcherArea, investorArea, topLine };
}

function WholeChainChart({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();

  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return null;
    const tsMin = points[0].ts;
    const tsMax = points[points.length - 1].ts;
    const xScale = linearScale(tsMin, tsMax, 0, frame.innerWidth);
    let yMax = 0;
    for (const p of points) {
      const stacked = p.researchers + p.investors;
      if (stacked > yMax) yMax = stacked;
    }
    if (yMax === 0) yMax = 1;
    // ~5% headroom so the area doesn't kiss the frame's top edge.
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5, true);
    return {
      tsMin, tsMax, xScale, yScale, yTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const paths = useMemo(() => {
    if (!layout) return null;
    return buildStackPaths(
      points,
      (p) => layout.xScale(p.ts),
      (n) => layout.yScale(n),
      frame.innerHeight,
    );
  }, [layout, points, frame.innerHeight]);

  if (!layout || frame.width === 0) return null;

  // Year ticks across the visible window — easier to scan than arbitrary
  // date stamps. Same X-axis treatment as the difficulty page.
  const startYear = new Date(layout.tsMin * 1000).getUTCFullYear();
  const endYear = new Date(layout.tsMax * 1000).getUTCFullYear();
  const xTicks: { value: number; x: number }[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const ts = Math.floor(Date.UTC(y, 0, 1) / 1000);
    if (ts < layout.tsMin || ts > layout.tsMax) continue;
    xTicks.push({ value: ts, x: layout.xScale(ts) });
  }

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
        {paths && (
          <>
            <path d={paths.researcherArea} fill={theme.palette.primary.main} fillOpacity={0.55} stroke="none" />
            <path d={paths.investorArea} fill={theme.palette.secondary.main} fillOpacity={0.4} stroke="none" />
            <path d={paths.topLine} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1.25} />
          </>
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
    // first-of-history) don't stretch a few days across the full tile
    // width — a visual lie about how long the year was.
    const year = Number(points[0].date.slice(0, 4));
    const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
    const xScale = linearScale(yearStart, yearEnd, 0, frame.innerWidth);
    let yMax = 0;
    for (const p of points) {
      const stacked = p.researchers + p.investors;
      if (stacked > yMax) yMax = stacked;
    }
    if (yMax === 0) yMax = 1;
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 3, true);
    return {
      year, yearStart, yearEnd, xScale, yScale, yTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const paths = useMemo(() => {
    if (!layout) return null;
    return buildStackPaths(
      points,
      (p) => layout.xScale(p.ts),
      (n) => layout.yScale(n),
      frame.innerHeight,
    );
  }, [layout, points, frame.innerHeight]);

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
        yFormat={(v) => formatCount(v)}
        xFormat={(ts) => {
          const d = new Date(ts * 1000);
          return MONTHS_SHORT[d.getUTCMonth()] ?? '???';
        }}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {paths && (
          <>
            <path d={paths.researcherArea} fill={theme.palette.primary.main} fillOpacity={0.55} stroke="none" />
            <path d={paths.investorArea} fill={theme.palette.secondary.main} fillOpacity={0.4} stroke="none" />
            <path d={paths.topLine} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1} />
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
    const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
    const xScale = linearScale(yearStart, yearEnd, 0, frame.innerWidth);
    let yMax = 0;
    for (const p of points) {
      const stacked = p.researchers + p.investors;
      if (stacked > yMax) yMax = stacked;
    }
    if (yMax === 0) yMax = 1;
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5, true);
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
    if (!layout) return null;
    return buildStackPaths(
      points,
      (p) => layout.xScale(p.ts),
      (n) => layout.yScale(n),
      frame.innerHeight,
    );
  }, [layout, points, frame.innerHeight]);

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
  const hoverTopY = hover ? layout.yScale(hover.researchers + hover.investors) : 0;

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
          yFormat={(v) => formatCount(v)}
          xFormat={(ts) => {
            const d = new Date(ts * 1000);
            return MONTHS_SHORT[d.getUTCMonth()] ?? '???';
          }}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          {paths && (
            <>
              <path d={paths.researcherArea} fill={theme.palette.primary.main} fillOpacity={0.55} stroke="none" />
              <path d={paths.investorArea} fill={theme.palette.secondary.main} fillOpacity={0.4} stroke="none" />
              <path d={paths.topLine} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1.5} />
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
                cy={hoverTopY}
                r={3.5}
                fill={theme.palette.secondary.main}
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
            <Box sx={{ minWidth: 200 }}>
              <Typography
                variant="caption"
                sx={{ display: 'block', fontWeight: 700, mb: 0.5 }}
              >
                {formatDate(hover.date)}
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <TooltipNum label="Researchers" value={formatCount(hover.researchers)} />
                <TooltipNum label="Investors" value={formatCount(hover.investors)} />
                <TooltipNum label="Total" value={formatCount(hover.total)} />
              </Stack>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.5 }}
              >
                {`${hover.blocks} PoS block${hover.blocks === 1 ? '' : 's'} · ${formatGrc(halfordToGrc(hover.mintTotal))} minted`}
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

export const getServerSideProps: GetServerSideProps<StakersHistoryProps> = async () => {
  try {
    const r = await api.get('/network/stakers', { params: { range: 'all' } });
    const points = (r.data?.data?.attributes?.points ?? []) as Point[];
    return { props: { points } };
  } catch {
    return { props: { points: [] } };
  }
};
