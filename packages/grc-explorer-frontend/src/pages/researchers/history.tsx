import {
  Box, Button, Card, CardActionArea, CardContent, Grid, Stack, Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Layout } from '../../layouts/Layout';
import {
  ChartAxes, ChartFrame, ChartFrameProvider, ChartTooltip, linearScale, niceTicks,
} from '../../components/charts/SvgChart';
import { CpidLabel } from '../../components/CpidLabel';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { CopyLinkButton } from '../../components/CopyLinkButton';
import { useXZoom, ZoomViewport, ZoomResetButton } from '../../components/charts/useXZoom';
import { useCpidNames } from '../../hooks/useCpidNames';
import { api } from '../../lib/api';
import { buildSmoothLinePath, paletteColor } from '../../lib/chartUtils';
import { formatCount, formatYmdDate, MONTHS_SHORT } from '../../lib/format';

interface Point {
  height: number;
  ts: number;
  date: string;
  active: number;
  totalMagnitude: number;
  top10Magnitude: number;
  top10Share: number;
}

interface SeriesPoint { height: number; magnitude: number }
interface Series { cpid: string; points: SeriesPoint[] }

interface ResearchersHistoryProps {
  points: Point[];
}

const formatDate = formatYmdDate;

function formatPct(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export default function ResearchersHistory({ points }: ResearchersHistoryProps) {
  const router = useRouter();
  const yearGroups = useMemo(() => groupByYear(points), [points]);

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
    for (const p of points) if (p.active > peakActive) peakActive = p.active;
    const last = points[points.length - 1];
    return {
      peakActive,
      currentActive: last.active,
      currentTop10Share: last.top10Share,
      firstDate: points[0].date,
      lastDate: last.date,
      superblocks: points.length,
    };
  }, [points]);

  const yearStats = useMemo(() => {
    if (selectedPoints.length === 0) return null;
    let peakActive = 0;
    for (const p of selectedPoints) if (p.active > peakActive) peakActive = p.active;
    const last = selectedPoints[selectedPoints.length - 1];
    return {
      peakActive,
      yearEndActive: last.active,
      yearEndTop10Share: last.top10Share,
      superblocks: selectedPoints.length,
    };
  }, [selectedPoints]);

  return (
    <Layout>
      <Head>
        <title>
          {selectedYear !== null
            ? `Gridcoin top researchers in ${selectedYear} — magnitude over the year`
            : 'Gridcoin top researchers history — magnitude leaderboard since genesis'}
        </title>
        <meta
          name="description"
          content={
            allTime
              ? `Gridcoin researcher magnitude history across ${allTime.superblocks.toLocaleString()} superblocks. Pick a year to see the top-20 researchers' magnitude trajectories with per-line tooltips.`
              : 'Whole-chain Gridcoin researcher leaderboard history with per-year breakdown.'
          }
        />
        <link rel="canonical" href="/researchers/history" />
      </Head>

      <Stack spacing={3}>
        <Crumbs
          trailing={<CopyLinkButton />}
          items={selectedYear !== null
            ? [
              RESEARCHERS_CRUMB,
              { label: 'Top researchers', href: '/' },
              { label: 'History', href: '/researchers/history' },
              { label: String(selectedYear) },
            ]
            : [
              RESEARCHERS_CRUMB,
              { label: 'Top researchers', href: '/' },
              { label: 'History' },
            ]}
        />
        <Box>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
            Top researchers history
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Top-30 researchers by magnitude across every superblock since
            genesis. Each line is one CPID — hover to identify. Pick a
            year tile to scope down to that year&apos;s top-20.
          </Typography>
        </Box>

        {selectedYear === null && allTime && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ flexWrap: 'wrap' }}
            useFlexGap
          >
            <Stat label="Superblocks" value={allTime.superblocks.toLocaleString()} />
            <Stat label="Currently active" value={formatCount(allTime.currentActive)} />
            <Stat label="All-time peak" value={formatCount(allTime.peakActive)} />
            <Stat label="Top-10 share" value={formatPct(allTime.currentTop10Share)} />
          </Stack>
        )}

        {selectedYear !== null && yearStats && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ flexWrap: 'wrap' }}
            useFlexGap
          >
            <Stat label="Superblocks" value={yearStats.superblocks.toLocaleString()} />
            <Stat label="Year-end active" value={formatCount(yearStats.yearEndActive)} />
            <Stat label="Peak active" value={formatCount(yearStats.peakActive)} />
            <Stat label="Top-10 share" value={formatPct(yearStats.yearEndTop10Share)} />
          </Stack>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, flex: 1, minWidth: 200 }}>
                {selectedYear !== null
                  ? `${selectedYear} — top-20 researchers by magnitude`
                  : 'Whole chain — top-20 researchers by magnitude'}
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
                ? 'Each line is one CPID — magnitude per superblock for the year. Top-20 ranked by total magnitude across the year (a weight of both peak and persistence). Hover any line to identify the researcher.'
                : 'Each line is one CPID — magnitude per superblock across every recorded superblock. Top-20 ranked by total magnitude across the whole chain. Hover any line to identify the researcher.'}
            </Typography>
            {selectedYear !== null
              ? <YearMultiLineChart year={selectedYear} yearPoints={selectedPoints} />
              : (
                points.length >= 2 ? (
                  <ChainMultiLineChart points={points} />
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                    No researcher history yet — the indexer is still warming
                    up to the first superblocks.
                  </Typography>
                )
              )}
          </CardContent>
        </Card>

        {yearGroups.length > 0 && (
          <Box>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              Year by year
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              Each tile traces the number of active researchers (distinct
              CPIDs earning magnitude) per superblock for one calendar
              year — a participation overview, not magnitude. Click a tile
              to drill into that year&apos;s top-20 researchers by magnitude
              above.
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

const SERIES_LIMIT = 20;

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

function maxActive(points: Point[]): number {
  let m = 1;
  for (const p of points) if (p.active > m) m = p.active;
  return m;
}

// Whole-chain wrapper: fetches the chain-wide top-20 series and
// forwards to MultiLineChart. Range bounds and x-tick values come
// from the SSR'd chain-wide points (which already span every
// indexed superblock).
function ChainMultiLineChart({ points }: { points: Point[] }) {
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const id = reqIdRef.current + 1;
    reqIdRef.current = id;
    setLoading(true);
    api.get('/metrics/researchers/history/series', {
      params: { limit: SERIES_LIMIT },
    }).then((r) => {
      if (reqIdRef.current !== id) return;
      const attrs = r.data?.data?.attributes as { series?: Series[] } | undefined;
      setSeries(attrs?.series ?? []);
      setLoading(false);
    }).catch(() => {
      if (reqIdRef.current !== id) return;
      setSeries([]);
      setLoading(false);
    });
  }, []);

  const names = useCpidNames(series.map((s) => s.cpid));

  if (loading && series.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.disabled">Loading top-20 series…</Typography>
      </Box>
    );
  }

  if (series.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.disabled">
          No researcher data yet.
        </Typography>
      </Box>
    );
  }

  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const startYear = new Date(tsMin * 1000).getUTCFullYear();
  const endYear = new Date(tsMax * 1000).getUTCFullYear();
  const xTickValues: number[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const ts = Math.floor(Date.UTC(y, 0, 1) / 1000);
    if (ts < tsMin || ts > tsMax) continue;
    xTickValues.push(ts);
  }

  return (
    <ChartFrameProvider height={360}>
      {(frame) => (
        <MultiLineChart
          frame={frame}
          referencePoints={points}
          series={series}
          names={names}
          xMin={tsMin}
          xMax={tsMax}
          xTickValues={xTickValues}
          xFormat={(ts) => String(new Date(ts * 1000).getUTCFullYear())}
        />
      )}
    </ChartFrameProvider>
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
              superblock
              {points.length === 1 ? '' : 's'}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Active researchers · peak
            {' '}
            {formatCount(maxActive(points))}
          </Typography>
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
    const yMax = maxActive(points);
    const yPad = yMax * 0.05 || 1;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 3, true);
    return {
      year, yearStart, yearEnd, xScale, yScale, yTicks,
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  if (!layout || frame.width === 0) return null;

  const activePath = buildSmoothLinePath(points, (p) => layout.xScale(p.ts), (n) => layout.yScale(n), (p) => p.active);

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
        {activePath && (
          <path d={activePath} fill="none" stroke={theme.palette.success.main} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
        )}
      </g>
    </svg>
  );
}

// Top-30 multi-line chart for the year drill-down. Each line is one
// CPID's magnitude trajectory across the year. Hover identifies the
// nearest line. Ranks come from the server (by total magnitude in
// the year); the rank drives palette colour assignment, so a CPID
// keeps the same hue across renders.
//
// Hover model: cursor → nearest superblock by x → for each series,
// the magnitude at that superblock → distance from cursor y → pick
// the closest. Highlights that line, dims the rest.

function YearMultiLineChart({
  year, yearPoints,
}: {
  year: number;
  yearPoints: Point[];
}) {
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const id = reqIdRef.current + 1;
    reqIdRef.current = id;
    setLoading(true);
    api.get(`/metrics/researchers/history/year/${year}/series`, {
      params: { limit: SERIES_LIMIT },
    }).then((r) => {
      if (reqIdRef.current !== id) return;
      const attrs = r.data?.data?.attributes as { series?: Series[] } | undefined;
      setSeries(attrs?.series ?? []);
      setLoading(false);
    }).catch(() => {
      if (reqIdRef.current !== id) return;
      setSeries([]);
      setLoading(false);
    });
  }, [year]);

  const names = useCpidNames(series.map((s) => s.cpid));

  if (yearPoints.length < 2) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          Need at least two superblocks in {year} to draw the chart.
        </Typography>
      </Box>
    );
  }

  if (loading && series.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.disabled">Loading top-20 series…</Typography>
      </Box>
    );
  }

  if (series.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.disabled">
          No researcher data in {year}.
        </Typography>
      </Box>
    );
  }

  const yearStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
  const yearEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
  const xTickValues: number[] = [];
  for (let i = 0; i < 12; i += 1) xTickValues.push(Math.floor(Date.UTC(year, i, 1) / 1000));

  return (
    <ChartFrameProvider height={360}>
      {(frame) => (
        <MultiLineChart
          frame={frame}
          referencePoints={yearPoints}
          series={series}
          names={names}
          xMin={yearStart}
          xMax={yearEnd}
          xTickValues={xTickValues}
          xFormat={(ts) => MONTHS_SHORT[new Date(ts * 1000).getUTCMonth()] ?? '???'}
        />
      )}
    </ChartFrameProvider>
  );
}

interface HoverState {
  cpid: string;
  height: number;
  magnitude: number;
  x: number;
  y: number;
  color: string;
}

function MultiLineChart({
  frame, referencePoints, series, names, xMin, xMax, xTickValues, xFormat,
}: {
  frame: ChartFrame;
  referencePoints: Point[];
  series: Series[];
  names: Map<string, string>;
  xMin: number;
  xMax: number;
  xTickValues: number[];
  xFormat: (ts: number) => string;
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const svgRef = useRef<SVGSVGElement | null>(null);

  const fullDomain = useMemo<[number, number]>(() => [xMin, xMax], [xMin, xMax]);
  const zoom = useXZoom({
    fullDomain, frame, svgRef, urlKey: 'z',
  });

  // Build a height → superblock-time lookup. Lets us position each
  // series sample on the same x scale as the reference points without
  // needing the server to re-emit times in the series payload.
  const heightToTs = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of referencePoints) m.set(p.height, p.ts);
    return m;
  }, [referencePoints]);

  const layout = useMemo(() => {
    if (referencePoints.length < 2 || frame.innerWidth <= 0) return null;
    const [dMin, dMax] = zoom.domain;
    const xScale = linearScale(dMin, dMax, 0, frame.innerWidth);
    let yMax = 0;
    for (const s of series) {
      for (const p of s.points) if (p.magnitude > yMax) yMax = p.magnitude;
    }
    if (yMax <= 0) yMax = 1;
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5);
    // Drop ticks outside the effective (possibly zoomed) window so they
    // rescale instead of piling up at the edges.
    const xTicks = xTickValues
      .filter((value) => value >= dMin && value <= dMax)
      .map((value) => ({ value, x: xScale(value) }));
    return {
      xScale, yScale, yTicks, xTicks, yMax: yMax + yPad,
    };
  }, [series, referencePoints, xTickValues, frame.innerWidth, frame.innerHeight, zoom.domain]);

  // Pre-compute the per-series colour from rank so all renders agree.
  // Hovering doesn't change the colour — the focused line stays its
  // own hue, just at full saturation with a thicker stroke and the
  // others dim around it.
  const colors = useMemo(() => series.map((_, i) => paletteColor(i, isDark)), [series, isDark]);

  const seriesPaths = useMemo(() => {
    if (!layout) return [];
    return series.map((s) => {
      const xy: Array<{ x: number; y: number }> = [];
      for (const p of s.points) {
        const ts = heightToTs.get(p.height);
        if (ts === undefined) continue;
        xy.push({ x: layout.xScale(ts), y: layout.yScale(p.magnitude) });
      }
      const path = buildSmoothLinePath(xy, (p) => p.x, (v) => v, (p) => p.y);
      return { cpid: s.cpid, path };
    });
  }, [series, layout, heightToTs]);

  const [hover, setHover] = useState<HoverState | null>(null);

  const handleMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!layout) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * frame.width - frame.margin.left;
    const localY = ((e.clientY - rect.top) / rect.height) * frame.height - frame.margin.top;
    if (localX < 0 || localX > frame.innerWidth || localY < 0 || localY > frame.innerHeight) {
      setHover(null);
      return;
    }
    // Find the reference superblock whose x is closest to localX.
    let nearestPoint: Point | null = null;
    let bestDx = Infinity;
    for (const p of referencePoints) {
      const x = layout.xScale(p.ts);
      const dx = Math.abs(x - localX);
      if (dx < bestDx) { bestDx = dx; nearestPoint = p; }
    }
    if (!nearestPoint) { setHover(null); return; }
    // For each series, find magnitude at the nearest superblock height
    // (or the closest height available), then pick the series whose
    // resulting y is closest to localY.
    let bestRank = -1;
    let bestSeries: { cpid: string; magnitude: number; height: number } | null = null;
    let bestDy = Infinity;
    for (let i = 0; i < series.length; i += 1) {
      const s = series[i];
      let sp: SeriesPoint | null = null;
      let dh = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.height - nearestPoint.height);
        if (d < dh) { dh = d; sp = p; }
      }
      if (!sp) continue;
      const y = layout.yScale(sp.magnitude);
      const dy = Math.abs(y - localY);
      if (dy < bestDy) {
        bestDy = dy;
        bestRank = i;
        bestSeries = { cpid: s.cpid, magnitude: sp.magnitude, height: sp.height };
      }
    }
    if (!bestSeries) { setHover(null); return; }
    const ts = heightToTs.get(bestSeries.height) ?? nearestPoint.ts;
    setHover({
      cpid: bestSeries.cpid,
      height: bestSeries.height,
      magnitude: bestSeries.magnitude,
      x: layout.xScale(ts) + frame.margin.left,
      y: layout.yScale(bestSeries.magnitude) + frame.margin.top,
      color: colors[bestRank] ?? theme.palette.primary.main,
    });
  }, [layout, frame, referencePoints, series, heightToTs, colors, theme.palette.primary.main]);

  if (!layout || frame.width === 0) return null;

  return (
    <Box sx={{ position: 'relative' }}>
      <ZoomResetButton zoom={zoom} />
      <svg
        ref={svgRef}
        width="100%"
        height={frame.height}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        onMouseDown={zoom.onMouseDown}
        onMouseMove={(e) => { zoom.onMouseMove(e); if (zoom.dragging) setHover(null); else handleMove(e); }}
        onMouseUp={zoom.onMouseUp}
        onMouseLeave={() => { zoom.onMouseLeave(); setHover(null); }}
        onDoubleClick={zoom.onDoubleClick}
        style={{ display: 'block', cursor: 'crosshair' }}
      >
        <ChartAxes
          frame={frame}
          yTicks={layout.yTicks}
          xTicks={layout.xTicks}
          yFormat={(v) => v.toFixed(0)}
          xFormat={xFormat}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          <ZoomViewport zoom={zoom}>
            {/* Render highest ranks LAST so they paint over the others.
                Hover-target line gets full opacity + bumped stroke; the
                rest dim out around it. Distinct hue per rank from the
                golden-angle palette means every line keeps its identity
                even when stacked. */}
            {seriesPaths.slice().reverse().map(({ cpid, path }, revIdx) => {
              if (path === null) return null;
              const rank = seriesPaths.length - 1 - revIdx;
              const isFocus = hover?.cpid === cpid;
              const dimmed = hover !== null && !isFocus;
              const opacity = isFocus ? 1 : dimmed ? 0.08 : 0.7;
              const strokeWidth = isFocus ? 2.5 : 1.4;
              return (
                <path
                  key={cpid}
                  d={path}
                  fill="none"
                  stroke={colors[rank]}
                  strokeWidth={strokeWidth}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={opacity}
                  style={{ transition: 'opacity 80ms ease' }}
                />
              );
            })}
          </ZoomViewport>
          {hover && (
            <circle
              cx={hover.x - frame.margin.left}
              cy={hover.y - frame.margin.top}
              r={3.5}
              fill={hover.color}
              stroke={theme.palette.background.paper}
              strokeWidth={1.5}
            />
          )}
        </g>
      </svg>
      {hover && (
        <ChartTooltip
          visible
          x={hover.x}
          y={hover.y}
          content={(
            <Box sx={{ minWidth: 180 }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.25 }}>
                <Box sx={{
                  width: 10, height: 10, borderRadius: 0.5, bgcolor: hover.color,
                }}
                />
                <Link href={`/cpids/${hover.cpid}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <CpidLabel cpid={hover.cpid} name={names.get(hover.cpid)} />
                </Link>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {`Block #${hover.height.toLocaleString()}`}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {`magnitude ${hover.magnitude.toFixed(2)}`}
              </Typography>
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                {(() => {
                  const ts = heightToTs.get(hover.height);
                  return ts ? formatDate(new Date(ts * 1000).toISOString().slice(0, 10)) : '';
                })()}
              </Typography>
            </Box>
          )}
        />
      )}
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<ResearchersHistoryProps> = async () => {
  try {
    const r = await api.get('/metrics/researchers/history', { params: { range: 'all' } });
    const points = (r.data?.data?.attributes?.points ?? []) as Point[];
    return { props: { points } };
  } catch {
    return { props: { points: [] } };
  }
};
