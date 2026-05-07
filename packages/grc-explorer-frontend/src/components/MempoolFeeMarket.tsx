import { Box, Card, CardContent, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { BarChartCanvas, ChartFrameProvider } from './charts/SvgChart';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

interface Bucket { feePerKb: number; count: number }

/**
 * Live mempool histogram only — confirmed-fee percentiles live in
 * MempoolFeePercentiles. Splitting them lets each show its own
 * empty-state cleanly without one obscuring the other.
 */
export function MempoolFeeMarket() {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const cancelledRef = useRef(false);

  const refresh = useCallback(() => {
    api.get('/mempool/fee-histogram', { params: atParam(tm.at) }).then((r) => {
      if (cancelledRef.current) return;
      const attrs = r.data?.data?.attributes as { buckets: Bucket[] } | undefined;
      setBuckets(attrs?.buckets ?? []);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  useSSE(['mempool.fee_histogram'], (_topic, payload) => {
    if (tm.isReplay) return;
    // SSE emits snake_case (`fee_per_kb`) to match the daemon-ish event
    // convention; the REST `/mempool/fee-histogram` route returns
    // camelCase (`feePerKb`) per the Presenter convention. Normalise
    // both into the `Bucket` shape the chart expects so axis labels
    // don't render `undefinedundefined…`.
    const p = payload as { buckets: Array<Bucket | { fee_per_kb: number; count: number }> };
    setBuckets((p.buckets ?? []).map((b) => {
      const camel = b as Partial<Bucket>;
      const snake = b as Partial<{ fee_per_kb: number; count: number }>;
      return {
        feePerKb: camel.feePerKb ?? snake.fee_per_kb ?? 0,
        count: Number(b.count ?? 0),
      };
    }));
  });

  // Safety-net poll for when the SSE channel drops.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const total = buckets.reduce((acc, b) => acc + b.count, 0);

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Mempool fee market · live
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Pending tx fee distribution (fee per KB, halford). Refreshes every 5 seconds.
        </Typography>
        {total === 0 ? (
          <Box
            sx={{
              height: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.disabled',
              border: 1,
              borderStyle: 'dashed',
              borderColor: 'divider',
              borderRadius: 1,
              p: 2,
              textAlign: 'center',
            }}
          >
            <Typography variant="body2">
              Mempool is empty. No pending transactions to chart.
            </Typography>
          </Box>
        ) : (
          <ChartFrameProvider height={220} margin={{ top: 8, right: 8, bottom: 24, left: 36 }}>
            {(frame) => (
              <BarChartCanvas
                frame={frame}
                data={buckets as unknown as Array<Record<string, unknown>>}
                getValue={(d) => Number(d.count)}
                fill={theme.palette.secondary.main}
                yFormat={(v) => v.toFixed(0)}
                xFormat={(d) => `${d.feePerKb}`}
                integerTicks
                tooltipContent={(d) => (
                  <Box sx={{ minWidth: 130 }}>
                    <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                      {`Fee/KB: ${d.feePerKb}`}
                    </Typography>
                    <Box>{`${d.count} pending`}</Box>
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
