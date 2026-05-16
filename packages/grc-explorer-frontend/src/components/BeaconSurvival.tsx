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
  linearScale,
  niceTicks,
} from './charts/SvgChart';
import { useSSEDebounced } from '../hooks/useSSE';
import { useTimeMachine } from '../hooks/useTimeMachine';
import { EmptyState } from './EmptyState';

export interface Point {
  cohort: string;
  advertised: number;
  confirmed: number;
  renewed: number;
  expired: number;
}

/**
 * Beacon survival funnel — for each cohort month, how many beacons
 * advertised, then survived to confirmed/renewed/expired states. Read
 * from `/metrics/beacon-survival`. Renders as four overlaid lines so
 * you can see at a glance how the funnel compares across cohorts.
 */
export function BeaconSurvival({
  initialPoints = [],
}: {
  initialPoints?: Point[];
} = {}) {
  const tm = useTimeMachine();
  const [points, setPoints] = useState<Point[]>(initialPoints);
  const skipFirstFetchRef = useRef(initialPoints.length > 0);
  const cancelledRef = useRef(false);

  const refresh = useCallback(() => {
    api.get('/metrics/beacon-survival').then((r) => {
      if (cancelledRef.current) return;
      const attrs = r.data?.data?.attributes as { points: Point[] } | undefined;
      setPoints(attrs?.points ?? []);
    }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      refresh();
    }
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // Cohorts shift on month boundaries of chain-time. 5-minute debounce
  // is fine — the funnel only changes when a beacon expires or gets
  // superseded, both rare.
  useSSEDebounced(['block.new'], refresh, 5 * 60 * 1000, { skip: tm.isReplay });

  // Slow safety-net poll for when the SSE stream is dropped or paused
  // (e.g. user is on a backgrounded tab and `visibilitychange` skips
  // dispatch). 10 minutes — same intent as the other home cards;
  // this panel updates so rarely a cold pull is fine.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const empty = points.length < 2;

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary">
          Beacon survival
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Per-cohort funnel: advertised → confirmed → renewed → expired.
        </Typography>

        {empty ? (
          <EmptyState>
            <Typography variant="body2">
              Need at least two cohort months to draw a funnel.
            </Typography>
          </EmptyState>
        ) : (
          <>
            <FunnelLegend />
            <ChartFrameProvider height={220} margin={{ top: 8, right: 8, bottom: 28, left: 44 }}>
              {(frame) => <FunnelLines frame={frame} points={points} />}
            </ChartFrameProvider>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FunnelLegend() {
  const theme = useTheme();
  const items: Array<{ label: string; color: string }> = [
    { label: 'Advertised', color: theme.palette.primary.main },
    { label: 'Confirmed', color: theme.palette.secondary.main },
    { label: 'Renewed', color: theme.palette.success.main },
    { label: 'Expired', color: theme.palette.error.main },
  ];
  return (
    <Stack direction="row" spacing={2} sx={{ my: 0.75, flexWrap: 'wrap' }} useFlexGap>
      {items.map((it) => (
        <Stack key={it.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ width: 10, height: 10, bgcolor: it.color, borderRadius: 0.5 }} />
          <Typography variant="caption" color="text.secondary">{it.label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function FunnelLines({ frame, points }: { frame: ChartFrame; points: Point[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) {
      return {
        xs: [] as number[],
        yMax: 1,
        advertised: '',
        confirmed: '',
        renewed: '',
        expired: '',
      };
    }
    const xs = points.map((_, i) => (i / (points.length - 1)) * frame.innerWidth);
    let yMax = 0;
    for (const p of points) if (p.advertised > yMax) yMax = p.advertised;
    if (yMax === 0) yMax = 1;
    const yScale = linearScale(0, yMax, frame.innerHeight, 0);
    const buildLine = (key: keyof Point): string => {
      let parts = '';
      for (let i = 0; i < points.length; i += 1) {
        const v = points[i][key];
        if (typeof v !== 'number') continue;
        parts += `${i === 0 ? 'M' : ' L'} ${xs[i].toFixed(1)} ${yScale(v).toFixed(1)}`;
      }
      return parts;
    };
    return {
      xs,
      yMax,
      advertised: buildLine('advertised'),
      confirmed: buildLine('confirmed'),
      renewed: buildLine('renewed'),
      expired: buildLine('expired'),
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const yTicks = useMemo(() => niceTicks(0, layout.yMax, 4), [layout.yMax]);
  const xTicks = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) return [];
    const count = Math.min(points.length, 6);
    const out: { value: number; x: number; label: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const idx = Math.round((i / (count - 1)) * (points.length - 1));
      out.push({ value: idx, x: layout.xs[idx], label: points[idx].cohort });
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
        xTicks={xTicks.map((t) => ({ value: t.value, x: t.x }))}
        yFormat={(v) => v.toFixed(0)}
        xFormat={(idx) => xTicks.find((t) => t.value === idx)?.label ?? ''}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        <path d={layout.advertised} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
        <path d={layout.confirmed} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1.5} />
        <path d={layout.renewed} fill="none" stroke={theme.palette.success.main} strokeWidth={1.5} />
        <path d={layout.expired} fill="none" stroke={theme.palette.error.main} strokeWidth={1.5} />
      </g>
    </svg>
  );
}
