import {
  Box, Card, CardContent, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Layout } from '../../layouts/Layout';
import { AddressBalanceSparkline } from '../../components/AddressBalanceSparkline';
import { useSSE } from '../../hooks/useSSE';
import { api } from '../../lib/api';
import {
  formatGrc, formatTime, shortHash, timeAgo,
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
}

interface AddrTx {
  txId: string;
  height: number;
  delta: string;
  ts: number;
}

interface AddressDetailProps {
  initialAddr: Address | null;
  initialPending: string;
  initialTxs: AddrTx[];
}

export default function AddressDetail({
  initialAddr, initialPending, initialTxs,
}: AddressDetailProps) {
  const router = useRouter();
  const { address } = router.query;
  const [addr, setAddr] = useState<Address | null>(initialAddr);
  const [pending, setPending] = useState(initialPending);
  const [txs, setTxs] = useState<AddrTx[]>(initialTxs);

  useEffect(() => {
    if (!address) return;
    if (addr && addr.address === address) return;
    api.get(`/addresses/${address}`).then((r) => {
      setAddr(r.data?.data?.attributes ?? null);
      setPending(r.data?.pendingBalance ?? '0');
    }).catch(() => { /* ignore */ });
    api.get(`/addresses/${address}/transactions`, { params: { 'page[size]': 50 } }).then((r) => {
      const data = (r.data?.data ?? []) as Array<{ attributes: AddrTx }>;
      setTxs(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });
  }, [address, addr]);

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

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' } }}>
          <Stat label="Balance" value={`${formatGrc(addr.balance)} GRC`} />
          <Stat label="Pending" value={`${formatGrc(pending)} GRC`} muted />
          <Stat label="Received" value={`${formatGrc(addr.totalReceived)} GRC`} muted />
          <Stat label="Sent" value={`${formatGrc(addr.totalSent)} GRC`} muted />
        </Box>

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={4} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Detail label="Tx count" value={addr.txCount} />
              <Detail label="First seen at" value={addr.firstSeenBlock ? `#${addr.firstSeenBlock}` : '—'} />
              <Detail label="Last seen at" value={addr.lastSeenBlock ? `#${addr.lastSeenBlock}` : '—'} />
            </Stack>
          </CardContent>
        </Card>

        <AddressBalanceSparkline address={addr.address} />

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
      </Stack>
    </Layout>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <Card variant="outlined">
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

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body1">{value}</Typography>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<AddressDetailProps> = async (ctx) => {
  const { address } = ctx.params ?? {};
  if (typeof address !== 'string') return { notFound: true };
  try {
    const [addrR, txsR] = await Promise.all([
      api.get(`/addresses/${address}`).catch(() => null),
      api.get(`/addresses/${address}/transactions`, { params: { 'page[size]': 50 } }).catch(() => null),
    ]);
    const attrs = addrR?.data?.data?.attributes as Address | undefined;
    if (!attrs) return { notFound: true };
    const txData = (txsR?.data?.data ?? []) as Array<{ attributes: AddrTx }>;
    return {
      props: {
        initialAddr: attrs,
        initialPending: addrR?.data?.pendingBalance ?? '0',
        initialTxs: txData.map((d) => d.attributes),
      },
    };
  } catch {
    return { notFound: true };
  }
};

