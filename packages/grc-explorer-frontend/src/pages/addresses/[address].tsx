import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Layout } from '../../layouts/Layout';
import { AddressBalanceSparkline } from '../../components/AddressBalanceSparkline';
import { useSSE } from '../../hooks/useSSE';
import { api, notFoundOrRethrow } from '../../lib/api';
import {
  formatCompact, formatGrc, formatNumber, formatTime, formatUnixDate, shortHash, timeAgo,
} from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs } from '../../components/Crumbs';

interface Address {
  address: string;
  balance: string;
  totalReceived: string;
  totalSent: string;
  txCount: number;
  firstSeenBlock: number | null;
  lastSeenBlock: number | null;
  firstSeenTime: number | null;
  lastSeenTime: number | null;
}

interface AddrTx {
  txId: string;
  height: number;
  delta: string;
  ts: number;
}
interface LinkedWallet {
  cpid: string;
  address: string;
  beaconCount: number;
  stakedBlocks: number;
  mrcPayouts: number;
  firstHeight: number;
  lastHeight: number;
  balance?: string;
}

interface MssRegistryEntry {
  address: string;
  currentStatus: string;
  currentAllocationPct: number;
  currentDescription: string;
  totalPaid: string;
  payoutCount: number;
}

interface AddressDetailProps {
  initialAddr: Address | null;
  initialPending: string;
  initialTxs: AddrTx[];
  initialLinkedCpids: string[];
  initialLinkedWallets: LinkedWallet[];
  initialCombinedBalance: string;
  initialCombinedSharePct: number;
  initialShareOfSupplyPct: number;
  initialCombinedCount: number;
  initialMssEntry: MssRegistryEntry | null;
}

export default function AddressDetail({
  initialAddr, initialPending, initialTxs, initialLinkedCpids, initialLinkedWallets,
  initialCombinedBalance, initialCombinedSharePct, initialShareOfSupplyPct,
  initialCombinedCount, initialMssEntry,
}: AddressDetailProps) {
  const router = useRouter();
  const { address } = router.query;
  const [addr, setAddr] = useState<Address | null>(initialAddr);
  const [pending, setPending] = useState(initialPending);
  const [txs, setTxs] = useState<AddrTx[]>(initialTxs);
  const [linkedCpids, setLinkedCpids] = useState<string[]>(initialLinkedCpids);
  const [linkedWallets, setLinkedWallets] = useState<LinkedWallet[]>(initialLinkedWallets);
  const [combined, setCombined] = useState({
    balance: initialCombinedBalance,
    sharePct: initialCombinedSharePct,
    selfPct: initialShareOfSupplyPct,
    count: initialCombinedCount,
  });
  const [mssEntry, setMssEntry] = useState<MssRegistryEntry | null>(initialMssEntry);

  // The three /addresses/X, /addresses/X/transactions, /mandatory-
  // sidestakes/X fetches are independent — Promise.all collapses three
  // serial round trips into one wallclock. Address-keyed ref guards
  // skip the work entirely when the SSR-seeded data is for the address
  // we're rendering (steady state on first paint); deps on `address`
  // only so the post-fetch setAddr doesn't re-trigger the effect.
  const lastFetchedRef = useRef<string | null>(initialAddr?.address ?? null);
  useEffect(() => {
    if (typeof address !== 'string' || !address) return;
    if (lastFetchedRef.current === address) return;
    lastFetchedRef.current = address;
    Promise.all([
      api.get(`/addresses/${address}`).then((r) => {
        setAddr(r.data?.data?.attributes ?? null);
        setPending(r.data?.pendingBalance ?? '0');
        setLinkedCpids(r.data?.linkedCpids ?? []);
        setLinkedWallets(r.data?.linkedWallets ?? []);
        setCombined({
          balance: r.data?.combinedBalance ?? '0',
          sharePct: r.data?.combinedSharePct ?? 0,
          selfPct: r.data?.shareOfSupplyPct ?? 0,
          count: r.data?.combinedCount ?? 0,
        });
      }).catch(() => { /* ignore */ }),
      api.get(`/addresses/${address}/transactions`, { params: { 'page[size]': 50 } }).then((r) => {
        const data = (r.data?.data ?? []) as Array<{ attributes: AddrTx }>;
        setTxs(data.map((d) => d.attributes));
      }).catch(() => { /* ignore */ }),
      // MSS lookup — 404 is the steady state (most addresses aren't
      // protocol recipients), so a missing entry surfaces as null
      // without an error toast.
      api.get(`/mandatory-sidestakes/${address}`).then((r) => {
        const attrs = r.data?.data?.attributes as MssRegistryEntry | undefined;
        setMssEntry(attrs ?? null);
      }).catch(() => { setMssEntry(null); }),
    ]);
  }, [address]);

  // Live balance updates for *this* address only — server-side topic
  // filtering means we don't get the full firehose. The SSE payload
  // carries a hint delta; we re-fetch to get the canonical balance
  // including any concurrent mempool overlay.
  useSSE(address ? [`address.${address}.balance`, `address.${address}.tx`] : [], (topic) => {
    if (topic.endsWith('.balance')) {
      api.get(`/addresses/${address}`).then((r) => {
        setAddr(r.data?.data?.attributes ?? null);
      }).catch(() => { /* ignore */ });
    }
  });

  if (!addr) return <Layout><Typography>Loading…</Typography></Layout>;

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          { label: 'Wallets', href: '/wallets' },
          { label: shortHash(addr.address, 8, 6) },
        ]}
        />
        <Typography variant="h5" sx={{ fontWeight: 700, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {addr.address}
        </Typography>

        {mssEntry && mssEntry.currentStatus === 'MANDATORY' && (
          <Tooltip
            title={`Protocol-designated mandatory sidestake recipient. Every PoS block since V13 routes ${mssEntry.currentAllocationPct.toFixed(2)}% of the CoinStake reward here. Lifetime received via MSS: ${formatGrc(mssEntry.totalPaid)} GRC across ${mssEntry.payoutCount.toLocaleString()} payouts.`}
            placement="bottom-start"
            arrow
          >
            <Box>
              <Chip
                component={Link}
                href={`/mandatory-sidestakes/${addr.address}`}
                clickable
                label={`Mandatory sidestake recipient${mssEntry.currentDescription ? ` · ${mssEntry.currentDescription}` : ''} · ${mssEntry.currentAllocationPct.toFixed(2)}%`}
                color="primary"
                variant="filled"
                size="small"
                sx={{ alignSelf: 'flex-start', fontWeight: 600 }}
              />
            </Box>
          </Tooltip>
        )}

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' } }}>
          <Stat label="Balance" value={`${formatGrc(addr.balance)} GRC`} />
          <Stat label="Pending" value={`${formatGrc(pending)} GRC`} muted />
          <DualStat
            items={[
              { label: 'Received', value: `${formatGrc(addr.totalReceived)} GRC` },
              { label: 'Sent', value: `${formatGrc(addr.totalSent)} GRC` },
            ]}
            title={'Lifetime value into / out of this address across all '
              + 'transactions. Staking (coinstake) recirculates the same '
              + 'coins every block, so the staker’s own principal is '
              + 'netted out and only the reward counts as received. '
              + 'Ordinary transaction change is still included, per the '
              + 'standard explorer convention. The net position is the '
              + 'Balance, not Received minus Sent.'}
          />
          {linkedWallets.length > 0 && (
            <Stat
              label="Combined"
              value={`${formatGrc(combined.balance)} GRC`}
              title={`Full wallet cluster: ${combined.count} addresses `
                + `(common-input-ownership). Combined ${combined.sharePct}% `
                + `of money supply (this address alone: ${combined.selfPct}%).`}
            />
          )}
        </Box>

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={4} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Detail label="Tx count" value={addr.txCount} />
              <Detail
                label="First seen at"
                value={addr.firstSeenBlock ? `#${addr.firstSeenBlock}` : '—'}
                hint={addr.firstSeenTime ? formatUnixDate(addr.firstSeenTime) : undefined}
              />
              <Detail
                label="Last seen at"
                value={addr.lastSeenBlock ? `#${addr.lastSeenBlock}` : '—'}
                hint={addr.lastSeenTime ? formatUnixDate(addr.lastSeenTime) : undefined}
              />
            </Stack>
          </CardContent>
        </Card>

        {linkedCpids.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {linkedCpids.length === 1 ? 'Linked to CPID ' : 'Linked to CPIDs '}
            {linkedCpids.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <Link
                  href={`/cpids/${c}`}
                  style={{ color: 'inherit', fontFamily: 'monospace' }}
                >
                  <HashTrim text={c} head={8} tail={4} />
                </Link>
              </span>
            ))}
            {' — provably acted under '}
            {linkedCpids.length === 1 ? 'this CPID' : 'these CPIDs'}
            {' on-chain (beacon, coinstake, or MRC payout).'}
          </Typography>
        )}

        <AddressBalanceSparkline address={addr.address} />

        {/* Side-by-side on desktop with the transaction history on the
            left as the primary log; linked wallets on the right as a
            secondary lens. Falls back to a single stacked column on
            narrow viewports — both tables already scroll horizontally
            inside their Paper wrapper when columns don't fit. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: linkedWallets.length > 0 ? '1fr 1fr' : '1fr' },
            alignItems: 'start',
          }}
        >
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Transaction history</Typography>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>Tx</TableCell><TableCell>Height</TableCell><TableCell>Time</TableCell><TableCell align="right">Delta</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {txs.map((t) => (
                  <TableRow key={`${t.height}:${t.txId}`} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      <Link href={`/transactions/${t.txId}`} style={{ color: 'inherit' }}><HashTrim text={t.txId} /></Link>
                    </TableCell>
                    <TableCell>{t.height.toLocaleString()}</TableCell>
                    <TableCell title={formatTime(t.ts)}>{timeAgo(t.ts)}</TableCell>
                    <TableCell align="right" sx={{ color: Number(t.delta) >= 0 ? 'success.main' : 'error.main' }}>
                      {Number(t.delta) >= 0 ? '+' : ''}{formatGrc(t.delta)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>

          {linkedWallets.length > 0 && (
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
                Linked wallets ({linkedWallets.length})
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, pb: 1 }}>
                Other addresses that have provably acted as the same CPID(s)
                as this wallet — registered as a beacon, staked a block, or
                received an MRC payout.
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Address</TableCell>
                    <TableCell align="right">Balance</TableCell>
                    <TableCell>Via CPID</TableCell>
                    <TableCell>Activity</TableCell>
                    <TableCell>Block range</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {linkedWallets.map((w) => (
                    <TableRow key={`${w.cpid}:${w.address}`} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        <Link href={`/addresses/${w.address}`} style={{ color: 'inherit' }}>
                          <HashTrim text={w.address} head={6} tail={4} />
                        </Link>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {formatGrc(w.balance ?? '0')} GRC
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        <Link href={`/cpids/${w.cpid}`} style={{ color: 'inherit' }}>
                          <HashTrim text={w.cpid} head={6} tail={4} />
                        </Link>
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }} title={activityTooltip(w)}>
                        {activitySummary(w)}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {blockRange(w.firstHeight, w.lastHeight)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>
                      Combined (incl. this address)
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
                      title={`${combined.sharePct}% of money supply`}
                    >
                      {formatGrc(combined.balance)} GRC
                    </TableCell>
                    <TableCell colSpan={3} />
                  </TableRow>
                </TableBody>
              </Table>
            </Paper>
          )}
        </Box>
      </Stack>
    </Layout>
  );
}

// Compact "Activity" summary for a linked wallet — drops zero-count
// signals so a beacon-only wallet doesn't render "0 stakes · 0 mrc".
function activitySummary(w: { beaconCount: number; stakedBlocks: number; mrcPayouts: number }): string {
  const parts: string[] = [];
  if (w.beaconCount > 0) parts.push(`${formatCompact(w.beaconCount, 0)} bcn`);
  if (w.stakedBlocks > 0) parts.push(`${formatCompact(w.stakedBlocks, 0)} stk`);
  if (w.mrcPayouts > 0) parts.push(`${formatCompact(w.mrcPayouts, 0)} mrc`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function activityTooltip(w: { beaconCount: number; stakedBlocks: number; mrcPayouts: number }): string {
  const parts: string[] = [];
  if (w.beaconCount > 0) parts.push(`${formatNumber(w.beaconCount)} beacons`);
  if (w.stakedBlocks > 0) parts.push(`${formatNumber(w.stakedBlocks)} staked blocks`);
  if (w.mrcPayouts > 0) parts.push(`${formatNumber(w.mrcPayouts)} MRC payouts`);
  return parts.join(', ');
}

// "#1,155,920 – #1,856,584" or just "#24" when first === last. Full
// precision so a glance reveals the actual heights; cell uses
// whiteSpace: nowrap so it stays a single line.
function blockRange(first: number, last: number): string {
  if (first === last) return `#${formatNumber(first)}`;
  return `#${formatNumber(first)} – #${formatNumber(last)}`;
}

function Stat({
  label, value, muted, title,
}: { label: string; value: string; muted?: boolean; title?: string }) {
  return (
    <Card variant="outlined" title={title}>
      <CardContent>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
          {label}
        </Typography>
        <Typography variant={muted ? 'body1' : 'h5'} sx={{ fontWeight: muted ? 400 : 700, mt: 0.5 }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

// Several related figures sharing one card, so a stat row spends one
// grid column on the group instead of one per figure.
function DualStat({
  items, title,
}: {
  items: Array<{ label: string; value: string }>; title?: string;
}) {
  return (
    <Card variant="outlined" title={title}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap', justifyContent: 'space-between' }}
        >
          {items.map(({ label, value }) => (
            <Box key={label} sx={{ minWidth: 0 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ textTransform: 'uppercase', letterSpacing: 1 }}
              >
                {label}
              </Typography>
              <Typography variant="body1" sx={{ mt: 0.5 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

function Detail({
  label, value, hint,
}: { label: string; value: string | number; hint?: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body1">{value}</Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<AddressDetailProps> = async (ctx) => {
  const { address } = ctx.params ?? {};
  if (typeof address !== 'string') return { notFound: true };
  try {
    // MSS lookup fetched in parallel — 404 is steady-state for the
    // vast majority of addresses, so we swallow the error and treat
    // a missing entry as `initialMssEntry: null`. The SSR'd badge
    // means search engines see the MSS recipient status without a
    // CSR round trip.
    const [addrR, txsR, mssR] = await Promise.all([
      api.get(`/addresses/${address}`).catch(() => null),
      api.get(`/addresses/${address}/transactions`, { params: { 'page[size]': 50 } }).catch(() => null),
      api.get(`/mandatory-sidestakes/${address}`).catch(() => null),
    ]);
    const attrs = addrR?.data?.data?.attributes as Address | undefined;
    if (!attrs) return { notFound: true };
    const txData = (txsR?.data?.data ?? []) as Array<{ attributes: AddrTx }>;
    const mssAttrs = mssR?.data?.data?.attributes as MssRegistryEntry | undefined;
    return {
      props: {
        initialAddr: attrs,
        initialPending: addrR?.data?.pendingBalance ?? '0',
        initialTxs: txData.map((d) => d.attributes),
        initialLinkedCpids: (addrR?.data?.linkedCpids ?? []) as string[],
        initialLinkedWallets: (addrR?.data?.linkedWallets ?? []) as LinkedWallet[],
        initialCombinedBalance: (addrR?.data?.combinedBalance ?? '0') as string,
        initialCombinedSharePct: (addrR?.data?.combinedSharePct ?? 0) as number,
        initialShareOfSupplyPct: (addrR?.data?.shareOfSupplyPct ?? 0) as number,
        initialCombinedCount: (addrR?.data?.combinedCount ?? 0) as number,
        initialMssEntry: mssAttrs ?? null,
      },
    };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};

