import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

interface Split {
  researchSubsidy: string;
  blockSubsidy: string;
  researcherBlocks: number;
  investorBlocks: number;
  researchSharePct: number;
  hours?: number;
}

// Try widening the lookback automatically when nothing recent. While
// the indexer is still catching up to chain tip, "last 24h" can be
// completely empty of indexed activity even though blocks are landing
// to disk — they're just historical. Falling back to longer windows
// gives the panel something to show on day-1 testnet stacks.
const FALLBACK_WINDOWS_HOURS = [24, 24 * 7, 24 * 30, 24 * 365];

export function ResearchSplitDonut() {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [data, setData] = useState<Split | null>(null);
  const [windowHours, setWindowHours] = useState<number>(24);

  const cancelledRef = useRef(false);
  const refresh = useCallback(async () => {
    for (const hours of FALLBACK_WINDOWS_HOURS) {
      if (cancelledRef.current) return;
      try {

        const r = await api.get('/metrics/research-split', {
          params: { hours, ...atParam(tm.at) },
        });
        const attrs = r.data?.data?.attributes as Split | undefined;
        if (attrs && (Number(attrs.researchSubsidy) > 0 || Number(attrs.blockSubsidy) > 0)) {
          if (!cancelledRef.current) {
            setData(attrs);
            setWindowHours(hours);
          }
          return;
        }
      } catch (_err) {
        /* try next window */
      }
    }
    if (!cancelledRef.current) setData(null);
  }, [tm.at]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // Live updates ride on `metrics.tick` — same SSE topic the funds-flow
  // chart uses. Debounced to a slow cadence because each refresh
  // walks the fallback ladder, which can issue up to four
  // `/metrics/research-split` requests per attempt during early
  // testnet when the recent windows are empty.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['metrics.tick'], (_topic, payload) => {
    if (tm.isReplay) return;
    const m = payload as { granularity: string };
    if (m.granularity !== '1h') return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 30_000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Safety-net poll for when the SSE stream drops.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const slices = useMemo(() => (data
    ? [
      { name: 'Research reward', value: Number(data.researchSubsidy), fill: theme.palette.secondary.main },
      { name: 'Block reward', value: Number(data.blockSubsidy), fill: theme.palette.primary.main },
    ].filter((s) => s.value > 0)
    : []), [data, theme]);

  const empty = !data || slices.length === 0;

  const heading = (() => {
    if (windowHours <= 24) return 'last 24 hours';
    if (windowHours <= 24 * 7) return 'last 7 days';
    if (windowHours <= 24 * 30) return 'last 30 days';
    return 'all time';
  })();

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary">
          Research economy · {heading}
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: 'center' }}
        >
          {/* Donut takes the full card width on mobile so it doesn't clip
              against a narrow column. On desktop it's the left half of a
              two-column row. */}
          <Box sx={{ width: { xs: '100%', sm: '60%' }, height: 200, display: 'flex', justifyContent: 'center' }}>
            {empty ? (
              <Donut
                slices={[{ name: 'no data', value: 1, fill: theme.palette.action.disabledBackground }]}
              />
            ) : (
              <Donut slices={slices} />
            )}
          </Box>
          <Stack spacing={0.5} sx={{ textAlign: { xs: 'center', sm: 'left' }, alignItems: { xs: 'center', sm: 'flex-start' } }}>
            <Typography variant="h4" sx={{ fontWeight: 700 }}>
              {empty ? '—' : `${data.researchSharePct.toFixed(1)}%`}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {empty ? 'no reward activity in this window yet' : 'of reward went to researchers'}
            </Typography>
            {!empty && (
              <Typography variant="caption" sx={{ mt: 1 }}>
                {`${data.researcherBlocks} researcher · ${data.investorBlocks} investor blocks`}
              </Typography>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * Inline-SVG donut. Two slices is enough for the research/block split,
 * but the math handles N. Each slice is one <path> with a stroked arc;
 * no recharts ResponsiveContainer / ResizeObserver needed.
 */
function Donut({ slices }: { slices: Array<{ name: string; value: number; fill: string }> }) {
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 80;
  const innerR = 50;
  const total = slices.reduce((acc, s) => acc + s.value, 0) || 1;
  let cursor = -Math.PI / 2; // start at 12 o'clock
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s) => {
        const angle = (s.value / total) * Math.PI * 2;
        const a0 = cursor;
        const a1 = cursor + angle;
        cursor = a1;
        const sweep = angle > Math.PI ? 1 : 0;
        const x0 = cx + Math.cos(a0) * outerR;
        const y0 = cy + Math.sin(a0) * outerR;
        const x1 = cx + Math.cos(a1) * outerR;
        const y1 = cy + Math.sin(a1) * outerR;
        const x2 = cx + Math.cos(a1) * innerR;
        const y2 = cy + Math.sin(a1) * innerR;
        const x3 = cx + Math.cos(a0) * innerR;
        const y3 = cy + Math.sin(a0) * innerR;
        // Single-slice donut (one entry covering 100%): build as two
        // half-arcs to keep the path closed and renderable.
        const d = slices.length === 1
          ? `M ${cx + outerR} ${cy} A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy} A ${outerR} ${outerR} 0 1 1 ${cx + outerR} ${cy} M ${cx + innerR} ${cy} A ${innerR} ${innerR} 0 1 0 ${cx - innerR} ${cy} A ${innerR} ${innerR} 0 1 0 ${cx + innerR} ${cy} Z`
          : `M ${x0} ${y0} A ${outerR} ${outerR} 0 ${sweep} 1 ${x1} ${y1} L ${x2} ${y2} A ${innerR} ${innerR} 0 ${sweep} 0 ${x3} ${y3} Z`;
        return <path key={s.name} d={d} fill={s.fill} />;
      })}
    </svg>
  );
}
