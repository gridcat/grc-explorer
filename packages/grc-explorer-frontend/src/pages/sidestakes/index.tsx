import {
  Box, Card, CardContent, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { Crumbs } from '../../components/Crumbs';
import { NextMuiLink } from '../../components/NextMuiLink';
import { HashTrim } from '../../components/HashTrim';
import type { SidestakeMetrics } from '../../components/SidestakesTiles';
import { useSSE } from '../../hooks/useSSE';
import { api } from '../../lib/api';
import {
  formatGrc, formatGrcShort, formatNumber, formatTime,
} from '../../lib/format';

interface Recipient {
  address: string;
  totalPaid: string;   // GRC
  payoutCount: number;
  amount24h: string;   // GRC
  count24h: number;
  firstBlockHeight: number;
  lastBlockHeight: number;
  lastTime: number;
}

interface SidestakesPageProps {
  initialRecipients: Recipient[];
  initialMetrics: SidestakeMetrics | null;
}

export default function SidestakesPage({ initialRecipients, initialMetrics }: SidestakesPageProps) {
  const [recipients, setRecipients] = useState<Recipient[]>(initialRecipients);
  const [metrics, setMetrics] = useState<SidestakeMetrics | null>(initialMetrics);

  const refresh = () => {
    api.get('/voluntary-sidestakes').then((r) => {
      const data = (r.data?.data ?? []) as Array<{ attributes: Recipient }>;
      setRecipients(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });
    api.get('/metrics/voluntary-sidestakes').then((r) => {
      const attrs = r.data?.data?.attributes as SidestakeMetrics | undefined;
      if (attrs) setMetrics(attrs);
    }).catch(() => { /* ignore */ });
  };

  // New payouts shift every number on the page; registry changes can
  // reclassify a recipient between voluntary and mandatory.
  useSSE(['sidestake.update', 'sidestake.payout'], () => refresh());

  // Safety-net poll matched to the home tiles.
  useEffect(() => {
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Layout>
      <Seo
        title="Voluntary sidestakes — Gridcoin Explorer"
        description="Voluntary sidestakes on the Gridcoin chain: block rewards stakers share with other addresses, by recipient."
        path="/sidestakes"
      />

      <Stack spacing={3}>
        <Crumbs items={[{ label: 'Voluntary sidestakes' }]} />

        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Voluntary sidestakes
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            A staker can set their wallet to send a share of each staking
            reward to other addresses: a donation to the Gridcoin
            Foundation or a project, or a split to another wallet of
            their own. These are voluntary sidestakes. The protocol does
            not require them, and each staker picks the addresses and
            percentages. They are separate from{' '}
            <NextMuiLink href="/mandatory-sidestakes" prose>mandatory sidestakes</NextMuiLink>,
            which only pay addresses registered on chain. The explorer
            counts sidestakes from block v13 on.
          </Typography>
        </Box>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap' }}
        >
          <Stat
            label="Paid (24h)"
            value={metrics ? `${formatGrcShort(metrics.amount24h)} GRC` : '—'}
            accent
          />
          <Stat label="Payouts (24h)" value={metrics ? formatNumber(metrics.count24h) : '—'} />
          <Stat label="Recipients (24h)" value={metrics ? formatNumber(metrics.recipients24h) : '—'} />
          <Stat
            label="All-time paid"
            value={metrics ? `${formatGrcShort(metrics.amountAllTime)} GRC` : '—'}
            muted
          />
        </Stack>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle1" sx={{ p: 2, pb: 0, fontWeight: 700 }}>
            Top recipients
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ px: 2, display: 'block' }}>
            Top 100 by all-time amount received.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Address</TableCell>
                <TableCell align="right">Received (24h)</TableCell>
                <TableCell align="right">Total received</TableCell>
                <TableCell align="right">Payouts</TableCell>
                <TableCell>Last payout</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recipients.map((r) => (
                <TableRow key={r.address} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/addresses/${r.address}`} style={{ color: 'inherit' }}>
                      <HashTrim text={r.address} head={10} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.count24h > 0 ? `${formatGrc(r.amount24h)} GRC` : '—'}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {`${formatGrc(r.totalPaid)} GRC`}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatNumber(r.payoutCount)}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    <Link href={`/block/${r.lastBlockHeight}`} style={{ color: 'inherit' }}>
                      {`#${formatNumber(r.lastBlockHeight)}`}
                    </Link>
                    {' · '}
                    {formatTime(r.lastTime)}
                  </TableCell>
                </TableRow>
              ))}
              {recipients.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No voluntary sidestakes recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Layout>
  );
}

function Stat({
  label, value, accent, muted,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
  muted?: boolean;
}) {
  let color: string = 'text.primary';
  if (muted) color = 'text.secondary';
  if (accent) color = 'success.main';
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 160 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {label}
        </Typography>
        <Typography variant="h6" sx={{ fontWeight: muted ? 500 : 700, fontVariantNumeric: 'tabular-nums', color }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

export const getServerSideProps: GetServerSideProps<SidestakesPageProps> = async () => {
  const [recR, metR] = await Promise.all([
    api.get('/voluntary-sidestakes').catch(() => null),
    api.get('/metrics/voluntary-sidestakes').catch(() => null),
  ]);
  const data = (recR?.data?.data ?? []) as Array<{ attributes: Recipient }>;
  const metAttrs = metR?.data?.data?.attributes as SidestakeMetrics | undefined;
  return {
    props: {
      initialRecipients: data.map((d) => d.attributes),
      initialMetrics: metAttrs ?? null,
    },
  };
};
