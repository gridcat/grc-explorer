import {
  Box, Button, Card, CardContent, Stack, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTheme } from '@mui/material/styles';
import Link from 'next/link';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useTimeMachine } from '../hooks/useTimeMachine';

interface CohortPoint { monthOffset: number; bucketTs: number; active: number }
interface CohortPayload {
  cohort: string;
  horizon: number;
  cohortSize: number;
  points: CohortPoint[];
}

const COHORTS_BACK = 4;
const HORIZON = 12;

/**
 * Compact preview of CPID cohort retention — last 4 cohort months,
 * each as a tiny normalised sparkline. Links to /cpids/cohorts for
 * the full small-multiples page.
 */
export function CohortRetentionPreview() {
  const tm = useTimeMachine();
  const [cohorts, setCohorts] = useState<CohortPayload[]>([]);
  const cancelledRef = useRef(false);

  // We anchor the cohort labels on the indexer's latest indexed-block
  // time, not wall-clock. Wall-clock would request "April 2026"
  // cohorts during a backfill of 2017-era chain — every cohort would
  // resolve empty because no CPID was first-seen claiming in 2026 yet.
  const refresh = useCallback(async () => {
    let anchorTs: number;
    try {
      const latestBlock = await api.get('/blocks', { params: { 'page[size]': 1 } });
      const t = latestBlock.data?.data?.[0]?.attributes?.time;
      anchorTs = typeof t === 'number' && t > 0 ? t : Math.floor(Date.now() / 1000);
    } catch {
      anchorTs = Math.floor(Date.now() / 1000);
    }
    const monthLabels = lastNCohortMonths(COHORTS_BACK, anchorTs);
    const results = await Promise.all(
      monthLabels.map((cohort) => api.get('/metrics/cpid-cohort-retention', {
        params: { cohort, horizon: HORIZON },
      }).then((r) => r.data?.data?.attributes as CohortPayload | undefined).catch(() => undefined)),
    );
    if (cancelledRef.current) return;
    setCohorts(results.filter((c): c is CohortPayload => Boolean(c) && c!.cohortSize > 0));
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // Cohorts only shift at month boundaries of chain-time, but we
  // listen to block.new with a slow debounce so a fresh cohort lands
  // on the dashboard within minutes of the indexer crossing a month.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 10 * 60 * 1000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Safety-net poll — cohorts shift on month boundaries of chain-time;
  // a slow cadence is plenty.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              CPID cohort retention
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {`Last ${COHORTS_BACK} cohort months · share still active.`}
            </Typography>
          </Box>
          <Button
            component={Link}
            href="/cpids/cohorts"
            size="small"
            color="primary"
            endIcon={<ChevronRightIcon fontSize="small" />}
            sx={{
              textTransform: 'none',
              fontSize: 13,
              fontWeight: 500,
              minWidth: 0,
              px: 1,
              py: 0.25,
            }}
          >
            See all
          </Button>
        </Stack>

        {cohorts.length === 0 ? (
          <Box sx={{
            mt: 2, p: 2, borderRadius: 1, color: 'text.disabled', textAlign: 'center', border: 1, borderStyle: 'dashed', borderColor: 'divider',
          }}
          >
            <Typography variant="body2">
              No cohort data yet. Populates as the indexer catches up.
            </Typography>
          </Box>
        ) : (
          <Box sx={{
            mt: 1.5, display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
          }}
          >
            {cohorts.map((c) => <CohortMini key={c.cohort} cohort={c} />)}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function CohortMini({ cohort }: { cohort: CohortPayload }) {
  const theme = useTheme();
  const w = 160;
  const h = 56;
  const padX = 4;
  const padY = 4;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const stepX = cohort.points.length > 1 ? innerW / (cohort.points.length - 1) : 0;
  let path = '';
  for (let i = 0; i < cohort.points.length; i += 1) {
    const ratio = cohort.cohortSize > 0 ? cohort.points[i].active / cohort.cohortSize : 0;
    const x = padX + i * stepX;
    const y = padY + innerH - innerH * Math.min(1, Math.max(0, ratio));
    path += `${i === 0 ? 'M' : ' L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  const finalRatio = cohort.points.length > 0 && cohort.cohortSize > 0
    ? (cohort.points[cohort.points.length - 1].active / cohort.cohortSize) * 100
    : 0;
  return (
    <Box>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>{cohort.cohort}</Typography>
        <Typography variant="caption" color="text.secondary">{`${finalRatio.toFixed(0)}%`}</Typography>
      </Stack>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        <line x1={padX} x2={padX + innerW} y1={padY + innerH} y2={padY + innerH} stroke={theme.palette.divider} />
        <path d={path} fill="none" stroke={theme.palette.primary.main} strokeWidth={1.5} />
      </svg>
    </Box>
  );
}

function lastNCohortMonths(n: number, anchorUnixSeconds: number): string[] {
  const anchor = new Date(anchorUnixSeconds * 1000);
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
