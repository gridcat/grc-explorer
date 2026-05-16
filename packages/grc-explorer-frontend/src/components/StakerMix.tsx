import {
  Box, Card, CardContent, LinearProgress, Stack, Typography,
} from '@mui/material';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';

export interface Mix {
  blocks: number;
  researcher: number;
  investor: number;
  researcherSharePct: number;
}

export function StakerMix({
  initialMix = null,
}: {
  initialMix?: Mix | null;
} = {}) {
  const tm = useTimeMachine();
  const [mix, setMix] = useState<Mix | null>(initialMix);

  const refresh = useCallback(() => {
    api.get('/metrics/staker-mix', { params: { blocks: 1000, ...atParam(tm.at) } }).then((r) => {
      const attrs = r.data?.data?.attributes as Mix | undefined;
      if (attrs) setMix(attrs);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  // Refresh strategy: initial fetch on mount, then SSE-driven updates
  // on `block.new` (debounced — backfill bursts fire many events per
  // second), with a slow safety-net poll only if SSE has gone silent.
  const lastEventAtRef = useRef<number>(Date.now());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstFetchRef = useRef(initialMix !== null);

  useEffect(() => {
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      refresh();
    }
    lastEventAtRef.current = Date.now();
    if (tm.isReplay) return undefined; // replay snapshot is fixed; no live polling
    const STALE_MS = 5 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (Date.now() - lastEventAtRef.current >= STALE_MS) {
        refresh();
        lastEventAtRef.current = Date.now();
      }
      timer = setTimeout(check, STALE_MS);
    };
    timer = setTimeout(check, STALE_MS);
    return () => {
      if (timer) clearTimeout(timer);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh, tm.isReplay]);

  // Update on new blocks. Debounced so a backfill burst (one
  // block.new per indexed block) collapses into one refresh per
  // window — the staker-mix endpoint walks the latest 1000 blocks,
  // not exactly cheap.
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    lastEventAtRef.current = Date.now();
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 30_000);
  });

  // The endpoint always returns a populated payload now (zero counts
  // when the chain has nothing yet) — `mix` is null only during the
  // initial in-flight fetch. We render the panel either way; ratio bar
  // reads zero until real data lands.
  const m = mix ?? { blocks: 0, researcher: 0, investor: 0, researcherSharePct: 0 };
  const empty = m.blocks === 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary">
          Researcher vs investor blocks · last 1,000
        </Typography>
        <Box sx={{ mt: 2 }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2">
              Researchers: <strong>{empty ? '—' : m.researcher.toLocaleString()}</strong>
            </Typography>
            <Typography variant="body2">
              Investors: <strong>{empty ? '—' : m.investor.toLocaleString()}</strong>
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={m.researcherSharePct}
            sx={{ height: 12, borderRadius: 1, mt: 1 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {empty
              ? 'Waiting for the indexer to land its first blocks…'
              : `${m.researcherSharePct.toFixed(1)}% of recent stakes came from researchers`}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}
