import {
  Box, Card, CardContent, Collapse, Link as MuiLink, Stack, Typography,
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
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { useSSE } from '../hooks/useSSE';

interface PercentilePoint { bucketTs: number; p50: number; p95: number; p99: number; txCount: number }
interface PercentileMeta {
  /** Most recent non-empty bucket anywhere in the MV, regardless of
   *  whether it falls in the 24h window. Lets us tell the user
   *  "the MV has data, just outside this window" vs "the MV is bare". */
  latestNonEmptyBucket: { bucketTs: number; txCount: number } | null;
  /** Number of distinct hourly buckets in the MV that hold at least
   *  one fee-paying user tx. 0 means the indexer hasn't crossed any
   *  fee-paying user txs yet (or the MV is broken). */
  totalNonEmptyBuckets: number;
  /** Anchor time the route used to define the right edge — for an
   *  actively-syncing chain this is the indexer tip, otherwise wall-
   *  clock now. Useful for debug; not displayed by default. */
  anchor: number;
}

const PERCENTILE_HOURS = 24;

/**
 * Confirmed-tx fee percentiles over time. Lives next to the live
 * mempool histogram; together they show "what the mempool wants now"
 * vs "what the chain has actually been charging." Reads pre-computed
 * `fee_percentiles` rows maintained by `FeePercentileJob`.
 */
export function MempoolFeePercentiles() {
  const tm = useTimeMachine();
  const [points, setPoints] = useState<PercentilePoint[]>([]);
  const [meta, setMeta] = useState<PercentileMeta | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const cancelledRef = useRef(false);

  // Single fetcher reused by the mount effect, the SSE-driven refresh,
  // and the slow safety-net poll. Wrapped in useCallback so the SSE
  // hook's stable callback identity holds across renders.
  const fetchOnce = useCallback(() => {
    api.get('/metrics/fee-percentiles', {
      params: { granularity: '1h', hours: PERCENTILE_HOURS, ...atParam(tm.at) },
    }).then((r) => {
      if (cancelledRef.current) return;
      const attrs = r.data?.data?.attributes as {
        points: Array<{ bucketTs: number; p50: string; p95: string; p99: string; txCount: number }>;
        latestNonEmptyBucket: { bucketTs: number; txCount: number } | null;
        totalNonEmptyBuckets: number;
        anchor: number;
      } | undefined;
      setPoints((attrs?.points ?? []).map((p) => ({
        bucketTs: p.bucketTs,
        p50: Number(p.p50),
        p95: Number(p.p95),
        p99: Number(p.p99),
        txCount: p.txCount,
      })));
      setMeta(attrs ? {
        latestNonEmptyBucket: attrs.latestNonEmptyBucket,
        totalNonEmptyBuckets: attrs.totalNonEmptyBuckets,
        anchor: attrs.anchor,
      } : null);
    }).catch(() => { /* ignore — fee_percentiles populates over time */ });
  }, [tm.at]);

  useEffect(() => {
    cancelledRef.current = false;
    fetchOnce();
    return () => { cancelledRef.current = true; };
  }, [fetchOnce]);

  // FeePercentileJob processes finalised buckets every 5 min, so the
  // underlying data can change on that cadence. Refetch on block.new
  // (debounced) so the chart picks up the new bucket as soon as the
  // job has written it; the 60-second debounce prevents a backfill
  // burst (one block.new per block) from hammering the endpoint.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      fetchOnce();
    }, 60_000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Safety-net poll for when SSE drops.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(fetchOnce, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchOnce, tm.isReplay]);

  // Buckets-with-zero-tx is the steady state on testnet (coinstake-only
  // blocks are excluded from percentiles), so distinguish "data missing"
  // from "data present but all-coinstake" in the empty-state copy below.
  const hasBuckets = points.length > 0;
  const hasData = points.some((p) => p.txCount > 0);

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
          {`Confirmed fee percentiles · last ${PERCENTILE_HOURS}h`}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
          {'p50 / p95 / p99 of fees actually paid by confirmed transactions. '}
          <MuiLink
            component="button"
            type="button"
            onClick={() => setExplainOpen((o) => !o)}
            sx={{ verticalAlign: 'baseline' }}
          >
            {explainOpen ? 'Hide details' : 'What does this mean?'}
          </MuiLink>
        </Typography>
        <Collapse in={explainOpen} unmountOnExit>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            A <strong>percentile</strong> is a way to summarise &quot;what
            fees were people actually paying&quot; without losing the
            shape of the distribution to a single average. For every
            bucket of confirmed transactions, we sort all the fees they
            paid and pick three landmarks:
          </Typography>
          <Box component="ul" sx={{ pl: 3, my: 0.5, color: 'text.secondary', '& li': { fontSize: 13 } }}>
            <li>
              <strong>p50</strong>: the <em>median</em>. Sort all the fees,
              take the one in the middle. Half of the transactions paid
              less than this, half paid more. This is the &quot;going
              rate&quot;.
            </li>
            <li>
              <strong>p95</strong>: only the top <strong>5 %</strong> of
              transactions paid more than this. Think of it as the &quot;fast
              lane&quot; price: what you&apos;d offer to outbid almost
              everyone else.
            </li>
            <li>
              <strong>p99</strong>: only the top <strong>1 %</strong> paid
              more. The outliers, what someone paid when they really
              needed to jump the queue (typically when blocks were
              stuffed and people were panicking).
            </li>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            <strong>Worked example.</strong> If 100 transactions confirmed in
            a 5-minute window with fees ranging from 1 000 to 8 000
            halford/KB, p50 might be 2 500 (half were under it), p95
            might be 5 800 (only 5 paid more), p99 might be 7 600 (only
            1 paid more).
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            <strong>How to read the chart.</strong> If p50, p95 and p99 are
            stacked tightly, everyone paid roughly the same; chain was
            uncongested. If p99 spikes far above p50, someone bid hard to
            jump the queue, a sign of mempool pressure. Independent of
            the live mempool: this view stays informative even when the
            mempool is empty right now.
          </Typography>
        </Collapse>
        {!hasData ? (
          <Box sx={{
            height: 220, p: 2, borderRadius: 1, color: 'text.disabled', textAlign: 'center', border: 1, borderStyle: 'dashed', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          >
            <EmptyStateMessage hasBuckets={hasBuckets} meta={meta} points={points} />
          </Box>
        ) : (
          <>
            <PercentileLegend />
            <ChartFrameProvider height={220} margin={{ top: 8, right: 8, bottom: 24, left: 56 }}>
              {(frame) => <PercentileEnvelope frame={frame} points={points} />}
            </ChartFrameProvider>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyStateMessage({
  hasBuckets, meta, points,
}: { hasBuckets: boolean; meta: PercentileMeta | null; points: PercentilePoint[] }) {
  // Diagnostic-aware empty state. Three branches:
  //   (a) MV is bare across all time           → indexer hasn't crossed
  //                                               any fee-paying user txs
  //                                               yet. Likely on testnet
  //                                               or in early backfill.
  //   (b) MV has data but not in this window   → tell the user when the
  //                                               most recent populated
  //                                               bucket is, so they
  //                                               understand the gap.
  //   (c) Buckets exist in window but all zero → the original "expected
  //                                               quiet" message.
  const totalNonEmpty = meta?.totalNonEmptyBuckets ?? 0;
  const latest = meta?.latestNonEmptyBucket;

  if (totalNonEmpty === 0) {
    return (
      <Typography variant="body2">
        No fee-bearing user transactions indexed yet.
        <br />
        <Typography
          component="span"
          variant="caption"
          sx={{ display: 'block', mt: 1, opacity: 0.85 }}
        >
          The percentiles MV stays empty until at least one user transaction
          with a non-zero fee crosses the indexer. On testnet that&apos;s
          uncommon; on mainnet it should populate as soon as backfill
          reaches blocks containing fee-paying transfers.
        </Typography>
      </Typography>
    );
  }

  if (latest && !hasBuckets) {
    const latestDate = new Date(latest.bucketTs * 1000).toISOString().slice(0, 10);
    return (
      <Typography variant="body2">
        {`No fee-bearing transactions in the last ${PERCENTILE_HOURS}h.`}
        <br />
        <Typography
          component="span"
          variant="caption"
          sx={{ display: 'block', mt: 1, opacity: 0.85 }}
        >
          {`Most recent populated bucket: ${latestDate} · ${latest.txCount} txs. `}
          {`The MV holds ${totalNonEmpty.toLocaleString('en-US')} non-empty hourly bucket${totalNonEmpty === 1 ? '' : 's'} across all of indexed time — they're just outside this window.`}
        </Typography>
      </Typography>
    );
  }

  // Fallback: window has buckets but countMerge is zero for every one
  // — shouldn't happen if the MV is healthy, so flag it loudly. Each
  // bucket in the MV is created by a matching INSERT, so by construction
  // countMerge should be >= 1.
  return (
    <Typography variant="body2">
      {`Window contained ${points?.length ?? 0} bucket${(points?.length ?? 0) === 1 ? '' : 's'}, all reporting zero fee txs.`}
      <br />
      <Typography
        component="span"
        variant="caption"
        sx={{ display: 'block', mt: 1, opacity: 0.85 }}
      >
        This is unexpected — buckets are only inserted into the MV when at
        least one fee-paying user tx matched the filter. If you see this,
        the AggregatingMergeTree state may be stale; restart the explorer
        or run `OPTIMIZE TABLE fee_quantiles_1h FINAL` in CH to merge.
      </Typography>
    </Typography>
  );
}

function PercentileLegend() {
  const theme = useTheme();
  // Append the meaning of each percentile to the swatch label so the
  // chart legend is self-explanatory without needing to refer back to
  // the prose above.
  const items: Array<{ label: string; color: string }> = [
    { label: 'p50 · median', color: theme.palette.primary.main },
    { label: 'p95 · top 5 %', color: theme.palette.secondary.main },
    { label: 'p99 · top 1 %', color: theme.palette.error.main },
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

function PercentileEnvelope({
  frame,
  points,
}: {
  frame: ChartFrame;
  points: PercentilePoint[];
}) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (points.length < 2 || frame.innerWidth <= 0) {
      return {
        xs: [] as number[],
        yMax: 1,
        seriesP50: '',
        seriesP95: '',
        seriesP99: '',
      };
    }
    const xs = points.map((_, i) => (i / (points.length - 1)) * frame.innerWidth);
    let yMax = 1;
    for (const p of points) if (p.p99 > yMax) yMax = p.p99;
    const yScale = linearScale(0, yMax, frame.innerHeight, 0);
    const buildLine = (key: 'p50' | 'p95' | 'p99'): string => {
      let parts = '';
      for (let i = 0; i < points.length; i += 1) {
        parts += `${i === 0 ? 'M' : ' L'} ${xs[i].toFixed(1)} ${yScale(points[i][key]).toFixed(1)}`;
      }
      return parts;
    };
    return {
      xs,
      yMax,
      seriesP50: buildLine('p50'),
      seriesP95: buildLine('p95'),
      seriesP99: buildLine('p99'),
    };
  }, [points, frame.innerWidth, frame.innerHeight]);

  const yTicks = useMemo(() => niceTicks(0, layout.yMax || 1, 4), [layout.yMax]);
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
        yFormat={(v) => formatHalford(v)}
        xFormat={(ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit' })}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        <path d={layout.seriesP99} fill="none" stroke={theme.palette.error.main} strokeWidth={1.5} />
        <path d={layout.seriesP95} fill="none" stroke={theme.palette.secondary.main} strokeWidth={1.5} />
        <path d={layout.seriesP50} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
      </g>
    </svg>
  );
}

function formatHalford(v: number): string {
  // Adaptive precision so a Y-axis spanning [0, 1] doesn't collapse to
  // `0 0 1 1`. niceTicks happily returns fractional steps like 0.25 /
  // 0.5 / 0.75 when the range is small, and toFixed(0) was wiping
  // every one of those to a duplicate `0` or `1`.
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}G`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v === 0 ? '0' : v.toExponential(1);
}
