import { Card, CardContent, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import {
  ChartAxes,
  ChartFrame,
  ChartFrameProvider,
  linearScale,
  niceTicks,
} from './charts/SvgChart';
import { formatGrcCompact } from '../lib/format';

interface Point { height: number; ts: number; balance: string }

const WINDOW_DAYS = 30;

/**
 * Address balance over time. Reads `address_balance_history` rows via
 * `/addresses/:addr/balance-history` and draws a single-line chart on
 * the address detail page.
 *
 * Granularity defaults to `1d` so the line traces daily-closing balance.
 * Past windows are stable — no SSE updates needed; on a balance change,
 * the parent re-fetches the address and we'll re-render with the latest
 * tail.
 */
export function AddressBalanceSparkline({ address }: { address: string }) {
  const [points, setPoints] = useState<Point[]>([]);

  useEffect(() => {
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    const from = now - WINDOW_DAYS * 86_400;
    api.get(`/addresses/${address}/balance-history`, {
      params: { from, to: now, granularity: '1d' },
    }).then((r) => {
      if (cancelled) return;
      const attrs = r.data?.data?.attributes as { points: Point[] } | undefined;
      setPoints(attrs?.points ?? []);
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [address]);

  if (points.length < 2) return null;

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
          {`Balance · last ${WINDOW_DAYS} days`}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Daily closing balance derived from `address_balance_history`.
        </Typography>
        <ChartFrameProvider height={180} margin={{ top: 8, right: 8, bottom: 24, left: 64 }}>
          {(frame) => <BalanceLine frame={frame} points={points} />}
        </ChartFrameProvider>
      </CardContent>
    </Card>
  );
}

function BalanceLine({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) {
      return { xs: [] as number[], yMax: 0, path: '' };
    }
    const xs = points.map((_, i) => (i / (points.length - 1)) * frame.innerWidth);
    let yMax = 0;
    for (const p of points) {
      const v = Number(p.balance);
      if (Number.isFinite(v) && v > yMax) yMax = v;
    }
    if (yMax === 0) yMax = 1;
    const yScale = linearScale(0, yMax, frame.innerHeight, 0);
    const parts: string[] = [];
    points.forEach((p, i) => {
      const v = Number(p.balance);
      parts.push(`${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${yScale(Number.isFinite(v) ? v : 0).toFixed(1)}`);
    });
    return { xs, yMax, path: parts.join(' ') };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const yTicks = useMemo(() => niceTicks(0, layout.yMax || 1, 5), [layout.yMax]);
  const xTicks = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return [];
    const count = 4;
    const out: { value: number; x: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i / (count - 1)) * (points.length - 1));
      out.push({ value: points[idx].ts, x: layout.xs[idx] });
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
        yFormat={formatGrcCompact}
        xFormat={(ts) => {
          const d = new Date(ts * 1000);
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        <path d={layout.path} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
      </g>
    </svg>
  );
}
