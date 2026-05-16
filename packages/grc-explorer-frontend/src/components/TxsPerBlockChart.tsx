import { Box, Card, CardContent, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { BarChartCanvas, ChartFrameProvider } from './charts/SvgChart';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

export interface Point {
  height: number;
  txCount: number;
}

const WINDOW = 90;

export function TxsPerBlockChart({
  initialPoints = [],
}: {
  initialPoints?: Point[];
} = {}) {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [points, setPoints] = useState<Point[]>(initialPoints);

  // SSE-aware fallback fetch — same pattern as LiveBlockTicker. SSE
  // `block.new` is the primary channel; we only re-fetch if nothing
  // has arrived in `STALE_MS`. Initial fetch on mount seeds the chart
  // with a real tail instead of waiting for the next live block, except
  // when SSR has already primed the points — then we skip the first
  // fetch and let SSE / the stale-check take over.
  const skipFirstFetchRef = useRef(initialPoints.length > 0);
  const lastEventAtRef = useRef<number>(Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => api.get('/blocks', { params: { 'page[size]': WINDOW, ...atParam(tm.at) } }).then((r) => {
      if (cancelled) return;
      const rows = (r.data?.data ?? []) as Array<{ attributes: { height: number; txCount: number } }>;
      const next = rows
        .map((row) => ({ height: row.attributes.height, txCount: row.attributes.txCount }))
        .reverse();
      setPoints((prev) => {
        // Merge by height — same shape as the SSE handler below — so
        // SSE-delivered points that landed mid-fetch aren't dropped on
        // resolution. Then take the most recent WINDOW points.
        const byHeight = new Map<number, Point>();
        for (const p of prev) byHeight.set(p.height, p);
        for (const p of next) byHeight.set(p.height, p);
        const merged = Array.from(byHeight.values())
          .sort((x, y) => x.height - y.height)
          .slice(-WINDOW);
        if (
          merged.length === prev.length
          && merged.every((p, i) => p.height === prev[i].height && p.txCount === prev[i].txCount)
        ) {
          return prev;
        }
        return merged;
      });
    }).catch(() => { /* ignore */ });
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      fetchOnce();
    }
    lastEventAtRef.current = Date.now();
    if (tm.isReplay) return () => { cancelled = true; };
    const STALE_MS = 3 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (cancelled) return;
      if (Date.now() - lastEventAtRef.current >= STALE_MS) {
        fetchOnce();
        lastEventAtRef.current = Date.now();
      }
      timer = setTimeout(check, STALE_MS);
    };
    timer = setTimeout(check, STALE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tm.at, tm.isReplay]);

  // Same coalescing pattern as LiveBlockTicker — one render per RAF
  // regardless of how many events landed in the gap. Cleanup cancels
  // the pending RAF on unmount so the closure can't retain old state.
  const queueRef = useRef<Array<{ height: number; txCount: number }>>([]);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (rafRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafRef.current);
    }
    queueRef.current = [];
  }, []);
  useSSE(['block.new'], (_topic, payload) => {
    if (tm.isReplay) return;
    lastEventAtRef.current = Date.now();
    const b = payload as { height: number; tx_count: number };
    queueRef.current.push({ height: b.height, txCount: b.tx_count });
    if (rafRef.current !== null) return;
    const flush = () => {
      rafRef.current = null;
      if (!mountedRef.current) return;
      const incoming = queueRef.current.splice(0);
      if (incoming.length === 0) return;
      setPoints((prev) => {
        const byHeight = new Map<number, { height: number; txCount: number }>();
        for (const p of prev) byHeight.set(p.height, p);
        for (const p of incoming) byHeight.set(p.height, p);
        return Array.from(byHeight.values())
          .sort((x, y) => x.height - y.height)
          .slice(-WINDOW);
      });
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      rafRef.current = window.requestAnimationFrame(flush);
    } else {
      const handle = setTimeout(flush, 16);
      rafRef.current = handle as unknown as number;
    }
  });

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Transactions per block · last 90 blocks
        </Typography>
        {points.length === 0 ? (
          <Box
            sx={{
              height: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.disabled',
            }}
          >
            <Typography variant="body2">Waiting for blocks…</Typography>
          </Box>
        ) : (
          <ChartFrameProvider height={220} margin={{ top: 8, right: 8, bottom: 24, left: 36 }}>
            {(frame) => (
              <BarChartCanvas
                frame={frame}
                data={points as unknown as Array<Record<string, unknown>>}
                getValue={(d) => Number(d.txCount)}
                fill={theme.palette.primary.main}
                yFormat={(v) => v.toFixed(0)}
                xFormat={(d) => `#${d.height}`}
                integerTicks
                tooltipContent={(d) => (
                  <Box sx={{ minWidth: 110 }}>
                    <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                      {`Block #${d.height}`}
                    </Typography>
                    <Box>{`${d.txCount} txs`}</Box>
                  </Box>
                )}
              />
            )}
          </ChartFrameProvider>
        )}
      </CardContent>
    </Card>
  );
}
