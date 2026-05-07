import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import {
  ChartAxes,
  ChartFrame,
  ChartFrameProvider,
  ChartTooltip,
  linearScale,
  niceTicks,
} from './charts/SvgChart';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { formatGrcCompact } from '../lib/format';

export interface Bucket {
  bucketTs: number;
  txValue: number;
  research: number;
  block: number;
}

const STEP = 300; // 5 minutes in seconds
const HOURS = 12;
const SLOTS = (HOURS * 3600) / STEP; // 144

interface MoneyFlowChartProps {
  /** Pre-fetched on the server so the chart paints with real data
   *  on first render instead of empty. Optional — when absent the
   *  component falls back to a CSR fetch on mount. */
  initialBuckets?: Bucket[];
}

export function MoneyFlowChart({ initialBuckets }: MoneyFlowChartProps = {}) {
  const tm = useTimeMachine();
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets ?? []);
  // Track whether the next time-machine effect run should skip its
  // fetch — true on first mount in live mode when we already have
  // SSR-seeded data (avoids a redundant network round-trip + chart
  // flicker between SSR data and refetched data).
  const skipFirstFetchRef = useRef<boolean>(
    !!initialBuckets && initialBuckets.length > 0,
  );

  const fetchBuckets = useCallback(() => api.get('/metrics', {
    params: { granularity: '5min', hours: HOURS, ...atParam(tm.at) },
  }).then((r) => {
    const rows = (r.data?.data ?? []) as Array<{
      attributes: {
        bucketTs: number;
        valueMoved: string;
        researchSubsidyTotal: string;
        blockSubsidyTotal: string;
      };
    }>;
    setBuckets(rows.map((row) => ({
      bucketTs: row.attributes.bucketTs,
      txValue: Number(row.attributes.valueMoved),
      research: Number(row.attributes.researchSubsidyTotal),
      block: Number(row.attributes.blockSubsidyTotal),
    })));
  }).catch(() => { /* ignore */ }), [tm.at]);

  // Refetch when the time-machine anchor moves. In live mode this fires
  // exactly once on mount; in replay mode every scrubber drag/play tick
  // re-fetches with the new ?at.
  useEffect(() => {
    if (skipFirstFetchRef.current && tm.at == null) {
      skipFirstFetchRef.current = false;
      return;
    }
    fetchBuckets();
  }, [tm.at, fetchBuckets]);

  // Live updates ride entirely on SSE — the payload carries the full
  // bucket totals, so we merge in place rather than re-hitting
  // /metrics. Replace by bucketTs (the same bucket re-fires as more
  // blocks land in the same 5-min window) and slice to the visible
  // 12 h relative to the newest bucket. The /metrics route now
  // anchors on the same indexer tip-time the SSE fires for, so
  // incoming bucket_ts values land within or just past the SSR
  // window — no big-jump collapse.
  useSSE(['metrics.tick'], (_topic, payload) => {
    if (tm.isReplay) return;
    const m = payload as {
      granularity: string;
      bucket_ts: number;
      value_moved: string;
      research_subsidy_total: string;
      block_subsidy_total: string;
    };
    if (m.granularity !== '5min') return;
    const incoming: Bucket = {
      bucketTs: m.bucket_ts,
      txValue: Number(m.value_moved),
      research: Number(m.research_subsidy_total),
      block: Number(m.block_subsidy_total),
    };
    setBuckets((prev) => {
      const merged = [...prev.filter((b) => b.bucketTs !== incoming.bucketTs), incoming];
      let maxTs = 0;
      for (const b of merged) if (b.bucketTs > maxTs) maxTs = b.bucketTs;
      const cutoff = maxTs - HOURS * 3600;
      return merged.filter((b) => b.bucketTs >= cutoff);
    });
  });

  // Safety-net poll: SSE merge keeps the chart fresh during normal
  // operation, but if the stream drops or the tab was hidden (we skip
  // dispatch in the SSE provider for hidden tabs) we want a cold
  // catch-up within a few minutes.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(fetchBuckets, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchBuckets, tm.isReplay]);

  // Aggregate stats across the visible window — totals for the
  // headline numbers, hourly averages so the magnitude is comparable
  // to other windows.
  const stats = useMemo(() => {
    if (buckets.length === 0) {
      return {
        txTotal: 0, researchTotal: 0, blockTotal: 0,
        txPerHour: 0, totalGrc: 0, hours: HOURS,
      };
    }
    const txTotal = buckets.reduce((a, b) => a + b.txValue, 0);
    const researchTotal = buckets.reduce((a, b) => a + b.research, 0);
    const blockTotal = buckets.reduce((a, b) => a + b.block, 0);
    return {
      txTotal,
      researchTotal,
      blockTotal,
      totalGrc: txTotal + researchTotal + blockTotal,
      txPerHour: txTotal / HOURS,
      hours: HOURS,
    };
  }, [buckets]);

  // Build a continuous 12-hour series anchored at the most recently
  // indexed block's bucket time. Right edge = max(bucketTs) so the
  // chart's right wall always sits at "the current block", not at
  // wall-clock now (which would float away during backfill, when the
  // indexer is hours behind real time).
  const series = useMemo<Bucket[]>(() => {
    if (buckets.length === 0) return [];
    let rightEdge = 0;
    for (const b of buckets) if (b.bucketTs > rightEdge) rightEdge = b.bucketTs;
    const leftEdge = rightEdge - HOURS * 3600;
    const map = new Map(buckets.map((b) => [b.bucketTs, b]));
    const out: Bucket[] = [];
    for (let i = 0; i <= SLOTS; i += 1) {
      const ts = leftEdge + i * STEP;
      out.push(map.get(ts) ?? {
        bucketTs: ts,
        txValue: 0,
        research: 0,
        block: 0,
      });
    }
    return out;
  }, [buckets]);

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Funds flow · last 12 hours · stacked by source
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Tx volume = GRC moved by user transactions (excludes coinbase / coinstake). Window
          ends at the latest indexed block.
        </Typography>

        <Stack
          direction="row"
          spacing={{ xs: 1.5, sm: 3 }}
          useFlexGap
          sx={{ mb: 2, flexWrap: 'wrap' }}
        >
          <Stat label="Total moved" value={`${formatGrcCompact(stats.totalGrc)} GRC`} />
          <Stat label={`Tx volume · ${stats.hours}h`} value={`${formatGrcCompact(stats.txTotal)} GRC`} />
          <Stat label={`Research reward · ${stats.hours}h`} value={`${formatGrcCompact(stats.researchTotal)} GRC`} />
          <Stat label={`Block reward · ${stats.hours}h`} value={`${formatGrcCompact(stats.blockTotal)} GRC`} />
          <Stat label="Avg tx volume / hour" value={`${formatGrcCompact(stats.txPerHour)} GRC`} />
        </Stack>

        <Legend />

        <ChartFrameProvider height={300} margin={{ top: 12, right: 12, bottom: 28, left: 56 }}>
          {(frame) => <StackedAreaCanvas frame={frame} series={series} />}
        </ChartFrameProvider>
      </CardContent>
    </Card>
  );
}

function Legend() {
  const theme = useTheme();
  // Block reward uses `success.main` rather than `primary.dark` so
  // testnet's amber palette doesn't end up with two near-identical
  // orange swatches (primary.main / primary.dark) that are hard to
  // tell apart in the legend or in the stacked area.
  const items: Array<{ label: string; color: string }> = [
    { label: 'Tx volume', color: theme.palette.primary.main },
    { label: 'Research reward', color: theme.palette.secondary.main },
    { label: 'Block reward', color: theme.palette.success.main },
  ];
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1, flexWrap: 'wrap' }} useFlexGap>
      {items.map((it) => (
        <Stack key={it.label} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 10, height: 10, bgcolor: it.color, borderRadius: 0.5 }} />
          <Typography variant="caption" color="text.secondary">{it.label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

interface StackedAreaCanvasProps {
  frame: ChartFrame;
  series: Bucket[];
}

function StackedAreaCanvas({ frame, series }: StackedAreaCanvasProps) {
  const theme = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (series.length < 2 || frame.innerWidth <= 0) {
      return { xs: [] as number[], stacks: [] as number[][], yMax: 0 };
    }
    const xs = series.map((_, i) => (i / (series.length - 1)) * frame.innerWidth);
    let yMax = 0;
    const stacks: number[][] = series.map((b) => {
      const sum = b.txValue + b.research + b.block;
      if (sum > yMax) yMax = sum;
      return [
        b.txValue,
        b.txValue + b.research,
        b.txValue + b.research + b.block,
      ];
    });
    if (yMax === 0) yMax = 1;
    return { xs, stacks, yMax };
  }, [series, frame.innerWidth]);

  const yTicks = useMemo(() => niceTicks(0, layout.yMax || 1, 5), [layout.yMax]);
  const yScale = useMemo(
    () => linearScale(0, yTicks[yTicks.length - 1] ?? 1, frame.innerHeight, 0),
    [yTicks, frame.innerHeight],
  );

  // Stacked-area paths. Each band fills between two consecutive tops in
  // `stacks` — index i is the cumulative sum up to the i-th series. We
  // prepend an implicit zero so band[0] (tx volume) draws from the X axis.
  const paths = useMemo(() => {
    if (layout.xs.length < 2) return null;
    const xs = layout.xs;
    const stacks = layout.stacks;
    const buildBand = (lowerIdx: number, upperIdx: number): string => {
      const top: string[] = [];
      const bot: string[] = [];
      for (let i = 0; i < xs.length; i += 1) {
        const upper = stacks[i][upperIdx];
        const lower = lowerIdx < 0 ? 0 : stacks[i][lowerIdx];
        top.push(`${xs[i].toFixed(1)},${yScale(upper).toFixed(1)}`);
        bot.unshift(`${xs[i].toFixed(1)},${yScale(lower).toFixed(1)}`);
      }
      return `M${top[0]} L${top.slice(1).join(' L')} L${bot.join(' L')} Z`;
    };
    return {
      tx: buildBand(-1, 0),
      research: buildBand(0, 1),
      block: buildBand(1, 2),
    };
  }, [layout, yScale]);

  const xTicks = useMemo(() => {
    // 4 evenly-spaced ticks across the visible window.
    if (series.length < 2 || frame.innerWidth <= 0) return [];
    const count = 4;
    const out: { value: number; x: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i / (count - 1)) * (series.length - 1));
      out.push({ value: series[idx].bucketTs, x: layout.xs[idx] });
    }
    return out;
  }, [series, layout.xs, frame.innerWidth]);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || layout.xs.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const localX = ((e.clientX - rect.left) / rect.width) * frame.width - frame.margin.left;
    if (localX < 0 || localX > frame.innerWidth) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.round((localX / frame.innerWidth) * (series.length - 1));
    setHoverIdx(Math.max(0, Math.min(series.length - 1, idx)));
  };

  if (frame.width === 0) return null;

  return (
    <>
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
          yTicks={yTicks}
          xTicks={xTicks}
          yFormat={(v) => formatGrcCompact(v)}
          xFormat={(ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        />
        <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
          {paths && (
            <>
              <path d={paths.block} fill={theme.palette.success.main} fillOpacity={0.7} stroke={theme.palette.success.dark} strokeWidth={1} />
              <path d={paths.research} fill={theme.palette.secondary.light} fillOpacity={0.85} stroke={theme.palette.secondary.main} strokeWidth={1} />
              <path d={paths.tx} fill={theme.palette.primary.light} fillOpacity={0.85} stroke={theme.palette.primary.main} strokeWidth={1} />
            </>
          )}
          {hoverIdx !== null && layout.xs[hoverIdx] !== undefined && (
            <line
              x1={layout.xs[hoverIdx]}
              x2={layout.xs[hoverIdx]}
              y1={0}
              y2={frame.innerHeight}
              stroke={theme.palette.text.secondary}
              strokeDasharray="3 3"
            />
          )}
        </g>
      </svg>
      {hoverIdx !== null && layout.xs[hoverIdx] !== undefined && (
        <ChartTooltip
          visible
          x={frame.margin.left + layout.xs[hoverIdx]}
          y={frame.margin.top}
          content={
            <Box sx={{ minWidth: 160 }}>
              <Typography variant="caption" sx={{ display: 'block', mb: 0.25, fontWeight: 600 }}>
                {new Date(series[hoverIdx].bucketTs * 1000).toLocaleString()}
              </Typography>
              <Box>{`Tx volume: ${formatGrcCompact(series[hoverIdx].txValue)} GRC`}</Box>
              <Box>{`Research: ${formatGrcCompact(series[hoverIdx].research)} GRC`}</Box>
              <Box>{`Block: ${formatGrcCompact(series[hoverIdx].block)} GRC`}</Box>
            </Box>
          }
        />
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        flex: { xs: '1 1 calc(50% - 12px)', sm: '0 0 auto' },
        minWidth: { xs: 0, sm: 140 },
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontSize: { xs: 9.5, sm: 10.5 },
          lineHeight: 1.3,
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          fontWeight: 600,
          mt: 0.25,
          fontSize: { xs: '0.95rem', sm: '1rem' },
          wordBreak: 'break-all',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

