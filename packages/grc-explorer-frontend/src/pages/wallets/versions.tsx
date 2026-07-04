import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import {
  useCallback, useMemo, useRef, useState,
} from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import {
  ChartAxes, ChartFrame, ChartFrameProvider, ChartLegend, ChartTooltip, linearScale, niceTicks,
} from '../../components/charts/SvgChart';
import { Crumbs, WALLETS_CRUMB } from '../../components/Crumbs';
import { CopyLinkButton } from '../../components/CopyLinkButton';
import { api } from '../../lib/api';
import { buildSmoothLinePath, paletteColor } from '../../lib/chartUtils';
import { useXZoom, ZoomViewport, ZoomResetButton } from '../../components/charts/useXZoom';
import { formatCount, formatYmdDate } from '../../lib/format';

interface VersionPoint {
  ts: number;
  date: string;
  counts: Record<string, number>;
  total: number;
}

interface VersionsPageProps {
  versions: string[];
  points: VersionPoint[];
}

function formatPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
}

export default function WalletVersions({ versions, points: rawPoints }: VersionsPageProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Coerce at the boundary — UInt64 sums can ship as strings, and a `+=`
  // on a string silently flatlines the chart.
  const points = useMemo<VersionPoint[]>(() => rawPoints.map((p) => ({
    ts: Number(p.ts),
    date: p.date,
    total: Number(p.total),
    counts: Object.fromEntries(
      Object.entries(p.counts ?? {}).map(([k, v]) => [k, Number(v)]),
    ),
  })), [rawPoints]);

  const colors = useMemo(() => versions.map((_, i) => paletteColor(i, isDark)), [versions, isDark]);
  const legend = useMemo(
    () => versions.map((v, i) => ({ label: v, color: colors[i] })),
    [versions, colors],
  );

  const summary = useMemo(() => {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    let topVersion = '—';
    let topShare = 0;
    for (const v of versions) {
      const share = last.total > 0 ? (last.counts[v] ?? 0) / last.total : 0;
      if (share > topShare) { topShare = share; topVersion = v; }
    }
    return {
      firstDate: points[0].date,
      lastDate: last.date,
      days: points.length,
      versionCount: versions.length,
      topVersion,
      topShare,
    };
  }, [points, versions]);

  return (
    <Layout>
      <Seo
        title="Gridcoin wallet versions over time — staking-client adoption"
        description={
          summary
            ? `Share of Gridcoin PoS blocks by the wallet client version that produced them, ${summary.firstDate} to ${summary.lastDate}. The ${summary.versionCount} highest-footprint releases across the chain's history; latest dominant version ${summary.topVersion} at ${formatPct(summary.topShare)}.`
            : 'Gridcoin staking-client version adoption over time, by share of PoS blocks produced, across the whole chain.'
        }
        path="/wallets/versions"
      />

      <Stack spacing={3}>
        <Crumbs items={[WALLETS_CRUMB, { label: 'Versions' }]} trailing={<CopyLinkButton />} />

        <Box>
          <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
            Wallet versions
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Staking-weighted: each line is a wallet client version&apos;s share
            of the PoS blocks produced over time. Non-staking nodes never
            write a claim, so they don&apos;t appear. The client version has
            been recorded in the coinstake since the earliest releases, so
            this spans the full chain — only the highest-footprint releases
            are drawn.
          </Typography>
        </Box>

        {summary && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ flexWrap: 'wrap' }}
            useFlexGap
          >
            <Stat label="Days indexed" value={summary.days.toLocaleString()} />
            <Stat label="Earliest" value={summary.firstDate} />
            <Stat label="Latest" value={summary.lastDate} />
            <Stat label="Releases shown" value={String(summary.versionCount)} />
            <Stat label="Latest dominant" value={`${summary.topVersion} · ${formatPct(summary.topShare)}`} />
          </Stack>
        )}

        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
              Version share of PoS blocks
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Each line is a release’s share of that day’s PoS blocks — the
              adoption waves as one version hands off to the next. Hover to
              focus a release.
            </Typography>
            <ChartLegend items={legend} />
            {points.length >= 2 ? (
              <Box sx={{ mt: 1.5 }}>
                <ChartFrameProvider height={380}>
                  {(frame) => (
                    <VersionsChart
                      frame={frame}
                      points={points}
                      versions={versions}
                      colors={colors}
                    />
                  )}
                </ChartFrameProvider>
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                No version data yet — the indexer is still warming up.
              </Typography>
            )}
          </CardContent>
        </Card>
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

interface HoverState {
  version: string;
  date: string;
  value: number;
  count: number;
  total: number;
  x: number;
  y: number;
  color: string;
}

function VersionsChart({
  frame, points, versions, colors,
}: {
  frame: ChartFrame; points: VersionPoint[]; versions: string[]; colors: string[];
}) {
  const theme = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const colorByVersion = useMemo(() => {
    const m = new Map<string, string>();
    versions.forEach((v, i) => m.set(v, colors[i]));
    return m;
  }, [versions, colors]);

  const fullDomain = useMemo<[number, number]>(
    () => [points[0]?.ts ?? 0, points[points.length - 1]?.ts ?? 1],
    [points],
  );
  const zoom = useXZoom({
    fullDomain, frame, svgRef, urlKey: 'z',
  });

  // A version's share at a point, or null when it produced no blocks that
  // day (so the line has a genuine gap rather than dropping to zero).
  const valueOf = useCallback((p: VersionPoint, v: string): number | null => {
    const c = p.counts[v];
    if (c === undefined) return null;
    return p.total > 0 ? c / p.total : 0;
  }, []);

  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return null;
    const [tsMin, tsMax] = zoom.domain;
    const xScale = linearScale(tsMin, tsMax, 0, frame.innerWidth);
    let yMax = 0;
    for (const p of points) {
      for (const v of versions) {
        const val = valueOf(p, v);
        if (val !== null && val > yMax) yMax = val;
      }
    }
    if (yMax === 0) yMax = 1;
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5, false);
    return {
      tsMin, tsMax, xScale, yScale, yTicks,
    };
  }, [points, versions, frame.innerWidth, frame.innerHeight, valueOf, zoom.domain]);

  const seriesPaths = useMemo(() => {
    if (!layout) return [];
    return versions.map((v) => {
      const xy: Array<{ x: number; y: number }> = [];
      for (const p of points) {
        const val = valueOf(p, v);
        if (val === null) continue;
        xy.push({ x: layout.xScale(p.ts), y: layout.yScale(val) });
      }
      return { version: v, path: buildSmoothLinePath(xy, (q) => q.x, (t) => t, (q) => q.y) };
    });
  }, [versions, points, layout, valueOf]);

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
    // Nearest day by x, then the version whose line is closest in y.
    let nearest: VersionPoint | null = null;
    let bestDx = Infinity;
    for (const p of points) {
      const dx = Math.abs(layout.xScale(p.ts) - localX);
      if (dx < bestDx) { bestDx = dx; nearest = p; }
    }
    if (!nearest) { setHover(null); return; }
    let bestV: string | null = null;
    let bestVal = 0;
    let bestDy = Infinity;
    for (const v of versions) {
      const val = valueOf(nearest, v);
      if (val === null) continue;
      const dy = Math.abs(layout.yScale(val) - localY);
      if (dy < bestDy) { bestDy = dy; bestV = v; bestVal = val; }
    }
    if (!bestV) { setHover(null); return; }
    setHover({
      version: bestV,
      date: nearest.date,
      value: bestVal,
      count: nearest.counts[bestV] ?? 0,
      total: nearest.total,
      x: layout.xScale(nearest.ts) + frame.margin.left,
      y: layout.yScale(bestVal) + frame.margin.top,
      color: colorByVersion.get(bestV) ?? theme.palette.primary.main,
    });
  }, [layout, frame, points, versions, valueOf, colorByVersion, theme.palette.primary.main]);

  if (!layout || frame.width === 0) return null;

  const startYear = new Date(layout.tsMin * 1000).getUTCFullYear();
  const endYear = new Date(layout.tsMax * 1000).getUTCFullYear();
  const xTicks: { value: number; x: number }[] = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const ts = Math.floor(Date.UTC(y, 0, 1) / 1000);
    if (ts < layout.tsMin || ts > layout.tsMax) continue;
    xTicks.push({ value: ts, x: layout.xScale(ts) });
  }

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
          xTicks={xTicks}
          yFormat={(v) => formatPct(v)}
          xFormat={(ts) => String(new Date(ts * 1000).getUTCFullYear())}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          <ZoomViewport zoom={zoom}>
            {seriesPaths.map(({ version, path }) => {
              if (path === null) return null;
              const isFocus = hover?.version === version;
              const dimmed = hover !== null && !isFocus;
              const opacity = isFocus ? 1 : dimmed ? 0.12 : 0.72;
              return (
                <path
                  key={version}
                  d={path}
                  fill="none"
                  stroke={colorByVersion.get(version)}
                  strokeWidth={isFocus ? 2.5 : 1.4}
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
                <Typography variant="caption" sx={{ fontWeight: 700 }}>{hover.version}</Typography>
              </Stack>
              <Typography variant="caption" sx={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}>
                {`${formatPct(hover.value)} · ${formatCount(hover.count)} of ${formatCount(hover.total)}`}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                {formatYmdDate(hover.date)}
              </Typography>
            </Box>
          )}
        />
      )}
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<VersionsPageProps> = async () => {
  try {
    const r = await api.get('/network/client-versions', { params: { range: 'all' } });
    const attrs = r.data?.data?.attributes ?? {};
    return {
      props: {
        versions: (attrs.versions ?? []) as string[],
        points: (attrs.points ?? []) as VersionPoint[],
      },
    };
  } catch {
    return { props: { versions: [], points: [] } };
  }
};
