import {
  Box, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LiveTxFeed } from '../components/LiveTxFeed';
import { MempoolFeeMarket } from '../components/MempoolFeeMarket';
import { Layout } from '../layouts/Layout';
import { api } from '../lib/api';
import { formatGrc, timeAgo } from '../lib/format';
import { track } from '../lib/track';
import { HashTrim } from '../components/HashTrim';

interface MempoolTx {
  txId: string;
  firstSeen: number;
  feeEstimate: string;
  size: number;
  vinCount: number;
  voutCount: number;
}

interface MempoolPageProps {
  initialRows: MempoolTx[];
}

export default function MempoolPage({ initialRows }: MempoolPageProps) {
  const [rows, setRows] = useState<MempoolTx[]>(initialRows);

  // Mempool is the one place we keep wall-clock polling: tx churn is
  // sub-second and SSE doesn't carry the full row payload, so a 5 s
  // refresh keeps the table aligned with the daemon's view. SSR
  // populates the first paint; this loop handles thereafter.
  useEffect(() => {
    const fetchOnce = () => api.get('/mempool', { params: { 'page[size]': 100 } }).then((r) => {
      const data = (r.data?.data ?? []) as Array<{ attributes: MempoolTx }>;
      setRows(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });
    const id = setInterval(fetchOnce, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <Layout>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Mempool</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Transactions that the network has accepted but no block has
            confirmed yet: validated by every peer that&apos;s seen them,
            paid a fee, and waiting to be included by a stake. Gridcoin
            rarely backlogs (block intervals are short and traffic is
            modest), so a sustained queue here usually signals fee-market
            pressure, a misconfigured wallet, or a long stake interval.
          </Typography>
        </Box>

        <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' } }}>
          <MempoolFeeMarket />
          <LiveTxFeed />
        </Box>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
            Pending transactions ({rows.length})
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tx ID</TableCell>
                <TableCell align="right">Fee est.</TableCell>
                <TableCell align="right">Size</TableCell>
                <TableCell align="right">Inputs</TableCell>
                <TableCell align="right">Outputs</TableCell>
                <TableCell>First seen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.txId} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link
                      href={`/transactions/${m.txId}`}
                      style={{ color: 'inherit' }}
                      onClick={() => track('Tx: open', { from: 'mempool' })}
                    >
                      <HashTrim text={m.txId} />
                    </Link>
                  </TableCell>
                  <TableCell align="right">{formatGrc(m.feeEstimate)}</TableCell>
                  <TableCell align="right">{m.size}</TableCell>
                  <TableCell align="right">{m.vinCount}</TableCell>
                  <TableCell align="right">{m.voutCount}</TableCell>
                  <TableCell>{timeAgo(m.firstSeen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<MempoolPageProps> = async () => {
  try {
    const r = await api.get('/mempool', { params: { 'page[size]': 100 } });
    const data = (r.data?.data ?? []) as Array<{ attributes: MempoolTx }>;
    return { props: { initialRows: data.map((d) => d.attributes) } };
  } catch {
    return { props: { initialRows: [] } };
  }
};
