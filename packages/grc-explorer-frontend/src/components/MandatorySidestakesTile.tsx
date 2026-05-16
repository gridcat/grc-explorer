import {
  Button, Card, CardContent, Chip, Stack, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Link from 'next/link';
import {
  useCallback, useEffect, useState,
} from 'react';
import { api } from '../lib/api';
import { formatGrcShort } from '../lib/format';
import { useSSE } from '../hooks/useSSE';
import { SeeMoreButton } from './SeeMoreButton';

export interface MssMetrics {
  amount24h: string;
  count24h: number;
  amountAllTime: string;
  countAllTime: number;
  activeRecipients: number;
}

interface NetworkForks {
  forks?: Record<string, boolean>;
}

/**
 * Home-page tile summarising mandatory sidestake activity. Pre-V13
 * (no recipients in the registry yet), the tile shows a friendly
 * "not yet activated" state instead of a row of zeros — the
 * /metrics/mandatory-sidestakes endpoint cheaply distinguishes those
 * cases via `activeRecipients`.
 *
 * Refresh model: SSE-driven on either `sidestake.update` (registry
 * change) or `sidestake.payout` (per-block payout summary), plus a
 * slow safety poll. Both topics fire at most once per block + once
 * per registry contract — order-of-magnitude cheaper than block.new.
 */
/**
 * SSR-prime via the parent page's getServerSideProps: pre-fetch
 * `/metrics/mandatory-sidestakes` server-side and pass via
 * `initialMetrics`. The CSR refresh path below still runs on top so
 * SSE updates and the hourly safety poll continue to work; we just
 * avoid the first-paint round-trip and the empty card flash.
 */
export function MandatorySidestakesTile({
  initialMetrics = null,
  initialV13Active = null,
}: {
  initialMetrics?: MssMetrics | null;
  initialV13Active?: boolean | null;
} = {}) {
  const [data, setData] = useState<MssMetrics | null>(initialMetrics);
  // V13 activation gate. Reads the network endpoint's `forks` map
  // and renders nothing until V13 has landed on chain. The same
  // endpoint also drives `network.stats` SSE pushes, so we re-check
  // whenever the daemon's tip moves — which means the tile flips
  // from hidden to visible automatically the moment the fork crosses
  // its activation height, no deploy required.
  const [v13Active, setV13Active] = useState<boolean | null>(initialV13Active);

  const refresh = useCallback(() => {
    api.get('/metrics/mandatory-sidestakes').then((r) => {
      const attrs = r.data?.data?.attributes as MssMetrics | undefined;
      if (attrs) setData(attrs);
    }).catch(() => { /* ignore */ });
  }, []);

  const refreshForks = useCallback(() => {
    api.get('/network').then((r) => {
      const attrs = r.data?.data?.attributes as NetworkForks | undefined;
      setV13Active(Boolean(attrs?.forks?.v13));
    }).catch(() => { /* leave the flag null on transient errors */ });
  }, []);

  // Skip the initial CSR fetch when SSR has already populated state.
  // SSE + safety poll keep things fresh from here on out.
  useEffect(() => { if (!initialMetrics) refresh(); }, [refresh, initialMetrics]);
  useEffect(() => { if (initialV13Active === null) refreshForks(); }, [refreshForks, initialV13Active]);

  useSSE(['sidestake.update', 'sidestake.payout'], () => refresh());
  useSSE(['network.stats'], () => refreshForks());

  useEffect(() => {
    // Safety-net poll. Same cadence as the other MSS-related panels:
    // hour-scale drift is fine because payouts only land at PoS block
    // cadence (~150s) and tile values track totals, not deltas.
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  // Hard gate: hide the entire tile until V13 has activated. The
  // backend already returns empty/zero payloads pre-V13, but rendering
  // a "pre-V13" placeholder on every home view permanently isn't the
  // right experience — the user shouldn't see a panel for a feature
  // that isn't live yet. `v13Active === null` (still resolving) hides
  // the tile too to avoid an initial-paint flicker on slow networks.
  if (v13Active !== true) return null;

  const preActivation = !!data && data.activeRecipients === 0 && data.countAllTime === 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
            Mandatory sidestakes · 24 h
          </Typography>
          <SeeMoreButton href="/mandatory-sidestakes" />
        </Stack>
        {preActivation ? (
          <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'center' }}>
            <Chip size="small" label="pre-V13" />
            <Typography variant="body2" color="text.secondary">
              Mandatory sidestaking activates at block V13. No recipients are registered yet.
            </Typography>
          </Stack>
        ) : (
          <Stack direction="row" spacing={3} sx={{ mt: 2, flexWrap: 'wrap' }} useFlexGap>
            <Stat label="Payouts (24h)" value={data?.count24h ?? '—'} />
            <Stat
              label="GRC paid (24h)"
              value={data ? `${formatGrc(data.amount24h)}` : '—'}
              accent="success"
            />
            <Stat label="Recipients" value={data?.activeRecipients ?? '—'} />
            <Stat
              label="All-time paid"
              value={data ? `${formatGrc(data.amountAllTime)}` : '—'}
              muted
            />
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

// Local alias to keep call sites terse. lib's formatGrcShort handles
// thousand-separator + 2-decimal cap + locale-pinned SSR.
const formatGrc = formatGrcShort;

function Stat({
  label, value, accent, muted,
}: {
  label: string;
  value: string | number;
  accent?: 'success' | 'warning';
  muted?: boolean;
}) {
  let color: string = 'text.primary';
  if (muted) color = 'text.secondary';
  if (accent === 'success') color = 'success.main';
  if (accent === 'warning') color = 'warning.main';
  return (
    <Stack>
      <Typography
        variant="h5"
        sx={{
          fontWeight: muted ? 500 : 700,
          color,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}
