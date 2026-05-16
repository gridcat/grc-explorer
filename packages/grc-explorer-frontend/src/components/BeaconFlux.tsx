import {
  Card, CardContent, Stack, Typography,
} from '@mui/material';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

export interface Flux {
  active: number;
  new: number;
  expired: number;
}

export function BeaconFlux({
  initialData = null,
}: {
  initialData?: Flux | null;
} = {}) {
  const tm = useTimeMachine();
  const [data, setData] = useState<Flux | null>(initialData);
  // Skip the on-mount fetch when SSR has already hydrated `data`.
  // Subsequent fetches via SSE / safety poll / time-machine still run
  // because they're driven by other effects below, not this seed.
  const skipFirstFetchRef = useRef(initialData !== null);

  const refresh = useCallback(() => {
    api.get('/metrics/beacon-flux', { params: { hours: 24, ...atParam(tm.at) } }).then((r) => {
      const attrs = r.data?.data?.attributes as Flux | undefined;
      if (attrs) setData(attrs);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => {
    if (skipFirstFetchRef.current) { skipFirstFetchRef.current = false; return; }
    refresh();
  }, [refresh, skipFirstFetchRef]);

  // SSE-driven refresh on `beacon.update` — fires only when a beacon
  // contract lands on chain. Order-of-magnitude cheaper than the
  // previous block.new + debounce combo, which fired ~1000× per real
  // beacon event during steady-state. Passive 180-day expiry is NOT
  // an on-chain event though, so the 24h "expired" count drifts
  // silently between events — the safety poll below catches that.
  useSSE(['beacon.update'], () => {
    if (tm.isReplay) return;
    refresh();
  });

  // Safety-net poll. 30 min is enough to catch passive expiry drift
  // (a beacon falling out of the 24 h window) without flooding the
  // endpoint; SSE auto-reconnects but doesn't replay, and useSSE
  // drops events while the tab is backgrounded.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary">
          Beacon flux · 24h
        </Typography>
        <Stack direction="row" spacing={3} sx={{ mt: 2 }}>
          <Stat label="Active" value={data?.active ?? '—'} />
          <Stat label="New" value={data?.new ?? '—'} accent="success" />
          <Stat label="Expired" value={data?.expired ?? '—'} accent="warning" />
        </Stack>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'success' | 'warning' }) {
  return (
    <Stack>
      <Typography
        variant="h4"
        sx={{
          fontWeight: 700,
          color: accent === 'success'
            ? 'success.main'
            : accent === 'warning'
              ? 'warning.main'
              : 'text.primary',
        }}
      >
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}
