import {
  Box, Card, CardContent, Chip, Stack, Typography,
} from '@mui/material';
import {
  ReactNode, useCallback, useEffect, useState,
} from 'react';
import { api } from '../lib/api';
import { formatGrcShort, formatNumber } from '../lib/format';
import { useSSE } from '../hooks/useSSE';
import { SeeMoreButton } from './SeeMoreButton';

export interface SidestakeMetrics {
  amount24h: string;
  count24h: number;
  recipients24h: number;
  amountAllTime: string;
  countAllTime: number;
}

export interface MssMetrics extends SidestakeMetrics {
  activeRecipients: number;
}

interface NetworkForks {
  forks?: Record<string, boolean>;
}

/**
 * Home-page pair of sidestake cards. The two kinds are kept visibly
 * apart because they mean different things:
 *   - voluntary: outputs a staker configured in their own wallet
 *     (/metrics/voluntary-sidestakes)
 *   - mandatory: outputs to recipients in the on-chain registry
 *     (/metrics/mandatory-sidestakes); while nothing is registered
 *     the card says so instead of showing a row of zeros.
 *
 * Refresh model: SSE-driven on `sidestake.update` (registry change)
 * or `sidestake.payout` (per-block payout summary), plus a slow
 * safety poll. Both topics fire at most once per block + once per
 * registry contract — order-of-magnitude cheaper than block.new.
 *
 * Gated on V13: the explorer only captures coinstake sidestakes from
 * V13 blocks, so the pair renders nothing until the fork is live.
 */
export function SidestakesTiles({
  initialMandatory = null,
  initialVoluntary = null,
  initialV13Active = null,
}: {
  initialMandatory?: MssMetrics | null;
  initialVoluntary?: SidestakeMetrics | null;
  initialV13Active?: boolean | null;
} = {}) {
  const [mandatory, setMandatory] = useState<MssMetrics | null>(initialMandatory);
  const [voluntary, setVoluntary] = useState<SidestakeMetrics | null>(initialVoluntary);
  // V13 activation gate. Reads the network endpoint's `forks` map and
  // re-checks on `network.stats` pushes, so the cards appear the moment
  // the fork crosses its activation height, no deploy required.
  const [v13Active, setV13Active] = useState<boolean | null>(initialV13Active);

  const refresh = useCallback(() => {
    api.get('/metrics/mandatory-sidestakes').then((r) => {
      const attrs = r.data?.data?.attributes as MssMetrics | undefined;
      if (attrs) setMandatory(attrs);
    }).catch(() => { /* ignore */ });
    api.get('/metrics/voluntary-sidestakes').then((r) => {
      const attrs = r.data?.data?.attributes as SidestakeMetrics | undefined;
      if (attrs) setVoluntary(attrs);
    }).catch(() => { /* ignore */ });
  }, []);

  const refreshForks = useCallback(() => {
    api.get('/network').then((r) => {
      const attrs = r.data?.data?.attributes as NetworkForks | undefined;
      setV13Active(Boolean(attrs?.forks?.v13));
    }).catch(() => { /* leave the flag null on transient errors */ });
  }, []);

  // Skip the initial CSR fetch when SSR has already populated state.
  useEffect(() => {
    if (!initialMandatory || !initialVoluntary) refresh();
  }, [refresh, initialMandatory, initialVoluntary]);
  useEffect(() => { if (initialV13Active === null) refreshForks(); }, [refreshForks, initialV13Active]);

  useSSE(['sidestake.update', 'sidestake.payout'], () => refresh());
  useSSE(['network.stats'], () => refreshForks());

  useEffect(() => {
    // Safety-net poll. Payouts land at PoS block cadence (~150s) and
    // the cards track totals, so hour-scale drift is fine.
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  // `v13Active === null` (still resolving) hides the cards too, to
  // avoid an initial-paint flicker on slow networks.
  if (v13Active !== true) return null;

  const noMandatory = !!mandatory && mandatory.activeRecipients === 0 && mandatory.countAllTime === 0;

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 3,
        gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
      }}
    >
      <SidestakeCard
        kind="Voluntary"
        title="Voluntary sidestakes"
        href="/sidestakes"
        metrics={voluntary}
        lead="shared in the last 24 h by stakers who set up sidestakes in their own wallets"
        recipientsLabel="Recipients (24h)"
        recipients={voluntary?.recipients24h}
      />
      <SidestakeCard
        kind="Mandatory"
        title="Mandatory sidestakes"
        href="/mandatory-sidestakes"
        metrics={mandatory}
        lead="paid in the last 24 h to recipients registered on chain"
        recipientsLabel="Registered recipients"
        recipients={mandatory?.activeRecipients}
        empty={noMandatory ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            No mandatory sidestake recipients are registered on chain.
            Every sidestake paid on this network so far is voluntary.
          </Typography>
        ) : null}
      />
    </Box>
  );
}

function SidestakeCard({
  kind, title, href, metrics, lead, recipientsLabel, recipients, empty = null,
}: {
  kind: 'Voluntary' | 'Mandatory';
  title: string;
  href: string;
  metrics: SidestakeMetrics | null;
  lead: string;
  recipientsLabel: string;
  recipients: number | undefined;
  empty?: ReactNode;
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip
            size="small"
            variant="outlined"
            color={kind === 'Mandatory' ? 'secondary' : 'primary'}
            label={kind}
            sx={{ fontWeight: 700 }}
          />
          <Typography variant="subtitle2" color="text.secondary" sx={{ flex: 1 }}>
            {title}
          </Typography>
          <SeeMoreButton href={href} />
        </Stack>
        {empty ?? (
          <>
            <Typography
              variant="h4"
              sx={{ mt: 2, fontWeight: 700, color: 'success.main', fontVariantNumeric: 'tabular-nums' }}
            >
              {metrics ? `${formatGrcShort(metrics.amount24h)} GRC` : '—'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {lead}
            </Typography>
            <Stack direction="row" spacing={3} sx={{ mt: 2, flexWrap: 'wrap' }} useFlexGap>
              <Stat label="Payouts (24h)" value={metrics ? formatNumber(metrics.count24h) : '—'} />
              <Stat label={recipientsLabel} value={recipients ?? '—'} />
              <Stat
                label="All-time"
                value={metrics ? `${formatGrcShort(metrics.amountAllTime)} GRC` : '—'}
              />
            </Stack>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Stack>
      <Typography variant="h6" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  );
}
