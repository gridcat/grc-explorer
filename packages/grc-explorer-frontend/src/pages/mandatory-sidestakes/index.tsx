import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Layout } from '../../layouts/Layout';
import { Crumbs } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { useSSE } from '../../hooks/useSSE';
import { api } from '../../lib/api';
import {
  formatGrc, formatGrcShort, formatNumber, formatTime,
} from '../../lib/format';

interface RegistryEntry {
  address: string;
  allocationPct: number;
  description: string;
  registeredTxId: string;
  registeredBlockHeight: number;
  registeredTime: number;
  totalPaid: string;   // GRC
  payoutCount: number;
}

interface MssMetrics {
  amount24h: string;
  count24h: number;
  amountAllTime: string;
  countAllTime: number;
  activeRecipients: number;
}

interface MandatorySidestakesPageProps {
  initialRegistry: RegistryEntry[];
  initialMetrics: MssMetrics | null;
}

export default function MandatorySidestakesPage({
  initialRegistry, initialMetrics,
}: MandatorySidestakesPageProps) {
  const [registry, setRegistry] = useState<RegistryEntry[]>(initialRegistry);
  const [metrics, setMetrics] = useState<MssMetrics | null>(initialMetrics);

  const refresh = () => {
    api.get('/mandatory-sidestakes').then((r) => {
      const data = (r.data?.data ?? []) as Array<{ attributes: RegistryEntry }>;
      setRegistry(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });
    api.get('/metrics/mandatory-sidestakes').then((r) => {
      const attrs = r.data?.data?.attributes as MssMetrics | undefined;
      if (attrs) setMetrics(attrs);
    }).catch(() => { /* ignore */ });
  };

  // SSE-driven refresh on either signal — registry changes or new
  // payouts both shift the page's numbers.
  useSSE(['sidestake.update', 'sidestake.payout'], () => refresh());

  // Safety-net poll matched to the home tile.
  useEffect(() => {
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const totalAllocation = registry.reduce((acc, r) => acc + r.allocationPct, 0);
  const preActivation = registry.length === 0 && (metrics?.countAllTime ?? 0) === 0;

  return (
    <Layout>
      <Head>
        <title>Mandatory sidestakes — Gridcoin Explorer</title>
        <meta
          name="description"
          content="Protocol-driven mandatory sidestakes on the Gridcoin chain — recipients, allocations, lifetime payouts. Activated at block v13."
        />
        <link rel="canonical" href="/mandatory-sidestakes" />
      </Head>

      <Stack spacing={3}>
        <Crumbs items={[{ label: 'Mandatory sidestakes' }]} />

        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Mandatory sidestakes
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Mandatory sidestakes route a fixed fraction of every PoS
            block reward to protocol-designated addresses (e.g. the
            Gridcoin Foundation). They activate at block v13 — until
            then, no recipients are registered and no payouts land.
            The set is governed by signed contracts in the chain, not
            hardcoded source: the daemon&apos;s{' '}
            <code>listmandatorysidestakes</code> RPC, the
            <code>{' '}sidestake</code> contract type, and a 25% global
            cap on summed allocation enforce the rules.
          </Typography>
        </Box>

        {preActivation ? (
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Chip label="pre-V13" />
                <Typography variant="body1">
                  Mandatory sidestaking has not activated yet — block v13 hasn&apos;t landed on this network.
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        ) : (
          <>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              <Stat label="Active recipients" value={metrics?.activeRecipients ?? registry.length} />
              <Stat label="Total allocation" value={`${totalAllocation.toFixed(2)}%`} />
              <Stat
                label="Paid (24h)"
                value={metrics ? `${formatPlainGrc(metrics.amount24h)} GRC` : '—'}
                accent="success"
              />
              <Stat label="Payouts (24h)" value={metrics?.count24h ?? '—'} />
              <Stat
                label="All-time paid"
                value={metrics ? `${formatPlainGrc(metrics.amountAllTime)} GRC` : '—'}
                muted
              />
            </Stack>

            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              <Typography variant="subtitle1" sx={{ p: 2, fontWeight: 700 }}>
                Active registry
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Address</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell align="right">Allocation</TableCell>
                    <TableCell align="right">Total received</TableCell>
                    <TableCell align="right">Payouts</TableCell>
                    <TableCell>Registered at</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {registry.map((r) => (
                    <TableRow key={r.address} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        <Link href={`/mandatory-sidestakes/${r.address}`} style={{ color: 'inherit' }}>
                          <HashTrim text={r.address} head={10} tail={6} />
                        </Link>
                      </TableCell>
                      <TableCell>{r.description || '—'}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {`${r.allocationPct.toFixed(2)}%`}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {`${formatGrc(r.totalPaid)} GRC`}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(r.payoutCount)}
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                        <Link href={`/block/${r.registeredBlockHeight}`} style={{ color: 'inherit' }}>
                          {`#${formatNumber(r.registeredBlockHeight)}`}
                        </Link>
                        {' · '}
                        {formatTime(r.registeredTime)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {registry.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                        No active mandatory sidestake recipients.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Paper>
          </>
        )}
      </Stack>
    </Layout>
  );
}

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

// Local alias — formatGrcShort truncates to 2 decimals for headline
// numbers; formatGrc keeps full halford precision elsewhere on this page.
const formatPlainGrc = formatGrcShort;

export const getServerSideProps: GetServerSideProps<MandatorySidestakesPageProps> = async () => {
  try {
    const [regR, metR] = await Promise.all([
      api.get('/mandatory-sidestakes').catch(() => null),
      api.get('/metrics/mandatory-sidestakes').catch(() => null),
    ]);
    const data = (regR?.data?.data ?? []) as Array<{ attributes: RegistryEntry }>;
    const metAttrs = metR?.data?.data?.attributes as MssMetrics | undefined;
    return {
      props: {
        initialRegistry: data.map((d) => d.attributes),
        initialMetrics: metAttrs ?? null,
      },
    };
  } catch {
    return { props: { initialRegistry: [], initialMetrics: null } };
  }
};
