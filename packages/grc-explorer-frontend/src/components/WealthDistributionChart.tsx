import {
  Box, Card, CardContent, Stack, Tooltip, Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useTheme } from '@mui/material/styles';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import {
  ChartAxes,
  ChartFrame,
  ChartFrameProvider,
  linearScale,
  niceTicks,
} from './charts/SvgChart';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

interface SeriesPoint {
  bucketTs: number;
  totalSupply: string;
  gini: number;
  top1pctShare: number;
  top10pctShare: number;
  top100Share: number;
  addressesWithBalance: number;
}

interface CurrentSnapshot {
  bucketTs: number;
  totalSupply: string;
  addressesWithBalance: number;
  gini: number;
  top1pctShare: number;
  top10pctShare: number;
  top100Share: number;
  active24h: number;
  new24h: number;
  hodler30d: number;
  hodler180d: number;
}

const WINDOW_DAYS = 365;

/**
 * Wealth-distribution dashboard panel. Two pieces:
 *   - headline tiles for the latest snapshot (Gini, top-1% share, etc)
 *   - a 365-day series of top-1/10/100 concentration shares
 *
 * Source rows are written by `WealthSnapshotJob` once a day, so this
 * panel reads pre-computed values — no aggregate queries on render.
 */
export function WealthDistributionChart() {
  const tm = useTimeMachine();
  const [current, setCurrent] = useState<CurrentSnapshot | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);

  // Snapshot + series fetcher. We deliberately *don't* pass
  // `from`/`to` when `tm.at` is null: wall-clock now is years ahead of
  // chain-time during backfill, and wealth_snapshots rows are anchored
  // on chain-tip-time, so a wall-clock window slides past every row.
  // The backend now defaults `to` to `getTipAnchor()`; we let it.
  const refresh = useCallback(() => {
    api.get('/metrics/wealth-distribution', { params: atParam(tm.at) }).then((r) => {
      const attrs = r.data?.data?.attributes as CurrentSnapshot | undefined;
      setCurrent(attrs ?? null);
    }).catch(() => { /* ignore — empty until WealthSnapshotJob's first run */ });

    const seriesParams = tm.at != null
      ? { from: tm.at - WINDOW_DAYS * 86_400, to: tm.at }
      : {};
    api.get('/metrics/wealth-distribution/series', { params: seriesParams }).then((r) => {
      const attrs = r.data?.data?.attributes as { points: SeriesPoint[] } | undefined;
      setSeries(attrs?.points ?? []);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => { refresh(); }, [refresh]);

  // Wealth snapshots are written at most once a day by WealthSnapshotJob,
  // so we don't need fast-cadence updates. Bind to block.new just in
  // case (with a generous 5-minute debounce) and keep the slow safety
  // poll.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 5 * 60 * 1000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Safety-net poll. Wealth snapshots are written hourly at most by
  // WealthSnapshotJob, so a slow cadence is plenty.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const empty = !current && series.length === 0;
  if (empty) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle2" color="text.secondary">
            Wealth distribution
          </Typography>
          <Box sx={{
            mt: 1, p: 2, borderRadius: 1, color: 'text.disabled', textAlign: 'center', border: 1, borderStyle: 'dashed', borderColor: 'divider',
          }}
          >
            <Typography variant="body2">
              Waiting for the first snapshot. WealthSnapshotJob runs hourly
              and writes one row per day. Give it a moment after the
              indexer catches up.
            </Typography>
          </Box>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary">
          Wealth distribution
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          How concentrated is the GRC supply? Lower Gini and lower top-N
          shares mean more even distribution; higher means a few
          addresses hold most of the coin.
        </Typography>
        {current && <SnapshotTiles snap={current} />}
        {series.length >= 2 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {`Top-N concentration share over the last ${WINDOW_DAYS} days`}
            </Typography>
            <ConcentrationLegend />
            <ChartFrameProvider height={220} margin={{ top: 8, right: 8, bottom: 24, left: 48 }}>
              {(frame) => <ConcentrationLines frame={frame} points={series} />}
            </ChartFrameProvider>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function SnapshotTiles({ snap }: { snap: CurrentSnapshot }) {
  // Each tile gets a one-line caption explaining the metric. Tooltips
  // carry the longer-form definition for hover (desktop) — captions
  // make sure the same info is visible on mobile, where there's no hover.
  return (
    <Stack
      direction="row"
      spacing={{ xs: 1.5, sm: 3 }}
      useFlexGap
      sx={{ flexWrap: 'wrap' }}
    >
      <Tile
        label="Gini"
        value={snap.gini.toFixed(3)}
        explainer="Inequality (0–1)"
        tooltip="Standard inequality coefficient over current GRC balances. 0 = everyone holds the same amount; 1 = one address holds everything. Excludes zero-balance addresses."
      />
      <Tile
        label="Top 1%"
        value={`${(snap.top1pctShare * 100).toFixed(1)}%`}
        explainer="Held by richest 1%"
        tooltip="Share of total supply held by the wealthiest 1% of addresses (with non-zero balance)."
      />
      <Tile
        label="Top 10%"
        value={`${(snap.top10pctShare * 100).toFixed(1)}%`}
        explainer="Held by richest 10%"
        tooltip="Share of total supply held by the wealthiest 10% of addresses."
      />
      <Tile
        label="Top 100"
        value={`${(snap.top100Share * 100).toFixed(1)}%`}
        explainer="Held by top 100 addresses"
        tooltip="Share of total supply held by the 100 richest addresses (or all of them, if the chain has fewer than 100 holders, which is common on a young testnet)."
      />
      <Tile
        label="Holders"
        value={snap.addressesWithBalance.toLocaleString()}
        explainer="Addresses with > 0 GRC"
        tooltip="Count of distinct addresses currently holding any non-zero balance."
      />
      <Tile
        label="Active 24h"
        value={snap.active24h.toLocaleString()}
        explainer="Distinct addresses with movement"
        tooltip="Distinct addresses whose balance changed in the last 24 hours; i.e., they sent or received coins. Sourced from address_balance_history."
      />
    </Stack>
  );
}

function Tile({
  label, value, explainer, tooltip,
}: {
  label: string; value: string; explainer: string; tooltip: string;
}) {
  return (
    <Box sx={{
      flex: { xs: '1 1 calc(50% - 12px)', sm: '0 0 auto' },
      minWidth: { xs: 0, sm: 130 },
    }}
    >
      <Tooltip title={tooltip} arrow placement="top">
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', cursor: 'help' }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              fontSize: { xs: 9.5, sm: 10.5 },
              lineHeight: 1.3,
            }}
          >
            {label}
          </Typography>
          <InfoOutlinedIcon
            sx={{ fontSize: { xs: 11, sm: 12 }, color: 'text.disabled' }}
          />
        </Stack>
      </Tooltip>
      <Typography
        sx={{
          fontWeight: 600,
          mt: 0.25,
          fontSize: { xs: '0.95rem', sm: '1.1rem' },
          lineHeight: 1.2,
        }}
      >
        {value}
      </Typography>
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{
          display: 'block',
          fontSize: { xs: 10, sm: 10.5 },
          lineHeight: 1.3,
          mt: 0.25,
        }}
      >
        {explainer}
      </Typography>
    </Box>
  );
}

function ConcentrationLegend() {
  const theme = useTheme();
  const items: Array<{ label: string; color: string }> = [
    { label: 'Top 1%', color: theme.palette.error.main },
    { label: 'Top 10%', color: theme.palette.secondary.main },
    { label: 'Top 100', color: theme.palette.primary.main },
  ];
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 0.5, flexWrap: 'wrap' }} useFlexGap>
      {items.map((it) => (
        <Stack key={it.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 10, height: 10, bgcolor: it.color, borderRadius: 0.5 }} />
          <Typography variant="caption" color="text.secondary">{it.label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function ConcentrationLines({ frame, points }: { frame: ChartFrame; points: SeriesPoint[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) {
      return { xs: [] as number[], yMax: 1, p1: '', p10: '', p100: '' };
    }
    const xs = points.map((_, i) => (i / (points.length - 1)) * frame.innerWidth);
    // Concentration values are fractions in [0, 1]. Use the actual max of
    // the visible series so the lines fill the chart vertical range —
    // sticking to a fixed 0..1 axis would compress the signal.
    let yMax = 0;
    for (const p of points) {
      if (p.top1pctShare > yMax) yMax = p.top1pctShare;
      if (p.top10pctShare > yMax) yMax = p.top10pctShare;
      if (p.top100Share > yMax) yMax = p.top100Share;
    }
    yMax = Math.min(1, Math.max(0.01, yMax));
    const yScale = linearScale(0, yMax, frame.innerHeight, 0);
    const buildLine = (key: 'top1pctShare' | 'top10pctShare' | 'top100Share'): string => {
      const parts: string[] = [];
      points.forEach((p, i) => {
        parts.push(`${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${yScale(p[key]).toFixed(1)}`);
      });
      return parts.join(' ');
    };
    return {
      xs,
      yMax,
      p1: buildLine('top1pctShare'),
      p10: buildLine('top10pctShare'),
      p100: buildLine('top100Share'),
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const yTicks = useMemo(() => niceTicks(0, layout.yMax, 5), [layout.yMax]);
  const xTicks = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return [];
    const count = 4;
    const out: { value: number; x: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i / (count - 1)) * (points.length - 1));
      out.push({ value: points[idx].bucketTs, x: layout.xs[idx] });
    }
    return out;
  }, [points, layout.xs, frame.innerWidth]);

  if (frame.width === 0 || points.length < 2) return null;

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
        yFormat={(v) => `${(v * 100).toFixed(0)}%`}
        xFormat={(ts) => {
          const d = new Date(ts * 1000);
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        <path d={layout.p100} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
        <path d={layout.p10} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1.5} />
        <path d={layout.p1} fill="none" stroke={theme.palette.error.main} strokeWidth={1.5} />
      </g>
    </svg>
  );
}
