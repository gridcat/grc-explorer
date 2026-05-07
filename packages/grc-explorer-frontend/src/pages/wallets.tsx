import {
  Box, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useState } from 'react';
import { Layout } from '../layouts/Layout';
import { api } from '../lib/api';
import { formatGrc } from '../lib/format';
import { HashTrim } from '../components/HashTrim';

interface Wallet {
  address: string;
  balance: string;
  totalReceived: string;
  totalSent: string;
  txCount: number;
  firstSeenBlock: number | null;
  lastSeenBlock: number | null;
}

interface WalletsPageProps {
  initialRows: Wallet[];
  initialTotal: number | null;
}

export default function WalletsPage({ initialRows, initialTotal }: WalletsPageProps) {
  const [rows] = useState<Wallet[]>(initialRows);
  const [total] = useState<number | null>(initialTotal);

  return (
    <Layout>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Top 100 wallets</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            The 100 addresses currently holding the largest balances.
            Useful for tracking supply concentration, identifying known
            holders and exchange-controlled wallets, and finding
            addresses worth a closer look. Balances reflect every
            confirmed input and output the indexer has seen; pending
            mempool moves are not included.
            {total !== null && ` ${total.toLocaleString()} addresses indexed in total.`}
          </Typography>
        </Box>
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 60 }}>#</TableCell>
                <TableCell>Address</TableCell>
                <TableCell align="right">Balance (GRC)</TableCell>
                <TableCell align="right">Received</TableCell>
                <TableCell align="right">Sent</TableCell>
                <TableCell align="right">Txs</TableCell>
                <TableCell sx={{ width: 130 }}>Last activity</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((w, i) => (
                <TableRow key={w.address} hover>
                  <TableCell sx={{ color: 'text.secondary' }}>{i + 1}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/addresses/${w.address}`} style={{ color: 'inherit' }}>
                      <HashTrim text={w.address} head={12} tail={8} />
                    </Link>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600 }}>{formatGrc(w.balance)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>{formatGrc(w.totalReceived)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>{formatGrc(w.totalSent)}</TableCell>
                  <TableCell align="right">{w.txCount.toLocaleString()}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>
                    {w.lastSeenBlock != null ? `#${w.lastSeenBlock.toLocaleString()}` : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No addresses indexed yet.
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


export const getServerSideProps: GetServerSideProps<WalletsPageProps> = async () => {
  try {
    const r = await api.get('/addresses', { params: { 'page[size]': 100 } });
    const data = (r.data?.data ?? []) as Array<{ attributes: Wallet }>;
    const meta = r.data?.meta as { count?: number } | undefined;
    return {
      props: {
        initialRows: data.map((d) => d.attributes),
        initialTotal: typeof meta?.count === 'number' ? meta.count : null,
      },
    };
  } catch {
    return { props: { initialRows: [], initialTotal: null } };
  }
};
