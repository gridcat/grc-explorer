import {
  Card, CardContent, Stack, Typography,
} from '@mui/material';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

interface Flux {
  active: number;
  new: number;
  expired: number;
}

export function BeaconFlux() {
  const tm = useTimeMachine();
  const [data, setData] = useState<Flux | null>(null);

  const refresh = useCallback(() => {
    api.get('/metrics/beacon-flux', { params: { hours: 24, ...atParam(tm.at) } }).then((r) => {
      const attrs = r.data?.data?.attributes as Flux | undefined;
      if (attrs) setData(attrs);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE-driven refresh — beacon counts shift on every contract-bearing
  // block. Debounced to absorb backfill bursts.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 60_000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 5 * 60 * 1000);
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
