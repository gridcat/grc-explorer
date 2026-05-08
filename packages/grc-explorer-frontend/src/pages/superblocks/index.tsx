import {
  Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useState } from 'react';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';

interface Superblock {
  height: number;
  quorumHash: string;
  totalMagnitude: number;
  cpidCount: number;
  projectCount: number;
}

interface SuperblocksListProps {
  initialRows: Superblock[];
}

export default function SuperblocksList({ initialRows }: SuperblocksListProps) {
  const [rows] = useState<Superblock[]>(initialRows);

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'Superblocks' },
        ]}
        />
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Superblocks</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Superblocks are periodic snapshots of every researcher&apos;s
          magnitude and every active project&apos;s beacon, pinned into
          the chain by a single block roughly every six hours. They&apos;re
          how Gridcoin agrees on who earned what research reward without
          re-tallying BOINC stats on every block. Every claim that pays
          a researcher between superblocks references the most recent
          one. Each row below links into the full per-CPID magnitude
          table for that snapshot.
        </Typography>
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Height</TableCell>
                <TableCell>Quorum</TableCell>
                <TableCell align="right">Total magnitude</TableCell>
                <TableCell align="right">CPIDs</TableCell>
                <TableCell align="right">Projects</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.height} hover>
                  <TableCell>
                    <Link href={`/superblocks/${s.height}`} style={{ color: 'inherit' }}>{s.height.toLocaleString()}</Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}><HashTrim text={s.quorumHash} /></TableCell>
                  <TableCell align="right">{s.totalMagnitude.toFixed(0)}</TableCell>
                  <TableCell align="right">{s.cpidCount.toLocaleString()}</TableCell>
                  <TableCell align="right">{s.projectCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<SuperblocksListProps> = async () => {
  try {
    const r = await api.get('/superblocks', { params: { 'page[size]': 50 } });
    const data = (r.data?.data ?? []) as Array<{ attributes: Superblock }>;
    return { props: { initialRows: data.map((d) => d.attributes) } };
  } catch {
    return { props: { initialRows: [] } };
  }
};
