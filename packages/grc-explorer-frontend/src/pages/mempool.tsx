import {
  Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LiveTxFeed } from '../components/LiveTxFeed';
import { MempoolFeeMarket } from '../components/MempoolFeeMarket';
import { Layout } from '../layouts/Layout';
import { useSSE } from '../hooks/useSSE';
import { api } from '../lib/api';
import { formatGrc } from '../lib/format';
import { track } from '../lib/track';
import { HashTrim } from '../components/HashTrim';
import { Crumbs } from '../components/Crumbs';
import { TimeAgo } from '../components/TimeAgo';

interface MempoolTx {
  txId: string;
  firstSeen: number;
  feeEstimate: string;
  size: number;
  vinCount: number;
  voutCount: number;
  isMrc?: boolean;
}

interface MempoolPageProps {
  initialRows: MempoolTx[];
}

const MAX_ROWS = 100;

export default function MempoolPage({ initialRows }: MempoolPageProps) {
  const [rows, setRows] = useState<MempoolTx[]>(initialRows);

  const refresh = useCallback(() => api
    .get('/mempool', { params: { 'page[size]': MAX_ROWS } })
    .then((r) => {
      const data = (r.data?.data ?? []) as Array<{ attributes: MempoolTx }>;
      setRows(data.map((d) => d.attributes));
    })
    .catch(() => { /* ignore */ }), []);

  // Safety-net poll for when SSE drops. Same shape as LiveTxFeed.
  useEffect(() => {
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  useSSE(['mempool.entered', 'mempool.exited'], (topic, payload) => {
    if (topic === 'mempool.entered') {
      const p = payload as {
        tx_id: string;
        fee: string;
        size: number;
        vin_count: number;
        vout_count: number;
        first_seen: number;
        is_mrc?: boolean;
      };
      setRows((prev) => {
        const filtered = prev.filter((e) => e.txId !== p.tx_id);
        return [
          {
            txId: p.tx_id,
            firstSeen: p.first_seen,
            feeEstimate: p.fee,
            size: p.size,
            vinCount: p.vin_count,
            voutCount: p.vout_count,
            isMrc: Boolean(p.is_mrc),
          },
          ...filtered,
        ].slice(0, MAX_ROWS);
      });
    } else if (topic === 'mempool.exited') {
      const p = payload as { tx_id: string };
      setRows((prev) => prev.filter((e) => e.txId !== p.tx_id));
    }
  });

  return (
    <Layout>
      <Stack spacing={3}>
        <Crumbs items={[{ label: 'Mempool' }]} />
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
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Link
                        href={`/transactions/${m.txId}`}
                        style={{ color: 'inherit' }}
                        onClick={() => track('Tx: open', { from: 'mempool' })}
                      >
                        <HashTrim text={m.txId} />
                      </Link>
                      {m.isMrc && <Chip label="MRC" size="small" color="secondary" variant="outlined" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{formatGrc(m.feeEstimate)}</TableCell>
                  <TableCell align="right">{m.size}</TableCell>
                  <TableCell align="right">{m.vinCount}</TableCell>
                  <TableCell align="right">{m.voutCount}</TableCell>
                  <TableCell><TimeAgo unixSec={m.firstSeen} /></TableCell>
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
