import {
  Box, Chip, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';

interface Beacon {
  cpid: string;
  address: string;
  status: 'active' | 'expired' | 'superseded' | 'revoked';
  txId: string;
  blockHeight: number;
  timestamp: number;
  expiration: number;
}

interface BeaconsPageProps {
  initialRows: Beacon[];
  initialTotal: number | null;
  initialStatus: string;
}

const STATUSES = ['all', 'active', 'expired', 'superseded', 'revoked'] as const;

export default function BeaconsPage({ initialRows, initialTotal, initialStatus }: BeaconsPageProps) {
  const router = useRouter();
  // Reading directly from props rather than holding them in `useState`
  // — Next.js calls `getServerSideProps` again on every tab change
  // (status query param flips), but `useState(initial)` only takes its
  // arg once at mount, so a stale list would otherwise stick around
  // after the navigation.
  const rows = initialRows;
  const total = initialTotal;
  const status = initialStatus;

  const onTabChange = (_e: React.SyntheticEvent, value: string) => {
    const next = value === 'all'
      ? { pathname: '/beacons' }
      : { pathname: '/beacons', query: { status: value } };
    router.push(next);
  };

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'Beacons' },
        ]}
        />
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Beacons</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Beacons are on-chain advertisements that link a researcher&apos;s
            CPID to a Gridcoin address. Every researcher who wants their
            BOINC magnitude rewarded must have a live beacon. Beacons
            expire after a fixed window (renewable via a fresh advertisement)
            and can be marked <em>superseded</em> when a newer beacon for
            the same CPID lands. Status is evaluated against current
            chain-time, not the value stored at write, so an &quot;active&quot;
            row really is still in force.
          </Typography>
        </Box>

        <Tabs
          value={status}
          onChange={onTabChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          {STATUSES.map((s) => (
            <Tab key={s} value={s} label={s} sx={{ textTransform: 'capitalize' }} />
          ))}
        </Tabs>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>CPID</TableCell>
                <TableCell>Address</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Advertised</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell sx={{ width: 100 }}>Block</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={`${b.cpid}-${b.txId}`} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/cpids/${b.cpid}`} style={{ color: 'inherit' }}>
                      {b.cpid}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/addresses/${b.address}`} style={{ color: 'inherit' }}>
                      <HashTrim text={b.address} head={10} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={b.status}
                      color={
                        b.status === 'active' ? 'success'
                          : b.status === 'expired' ? 'default'
                            : b.status === 'superseded' ? 'warning'
                              : 'error'
                      }
                      variant={b.status === 'active' ? 'filled' : 'outlined'}
                    />
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(b.timestamp)}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(b.expiration)}
                  </TableCell>
                  <TableCell>
                    <Link href={`/block/${b.blockHeight}`} style={{ color: 'inherit' }}>
                      {`#${b.blockHeight.toLocaleString()}`}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No beacons match this filter yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {total !== null && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 2 }}>
              {`${rows.length.toLocaleString()} of ${total.toLocaleString()} ${status === 'all' ? 'beacons indexed' : `${status} beacons`}.`}
            </Typography>
          )}
        </Paper>
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<BeaconsPageProps> = async (ctx) => {
  const status = typeof ctx.query.status === 'string' && (STATUSES as readonly string[]).includes(ctx.query.status)
    ? ctx.query.status
    : 'all';
  try {
    const params: Record<string, string | number> = { 'page[size]': 100 };
    if (status !== 'all') params.status = status;
    const r = await api.get('/beacons', { params });
    const data = (r.data?.data ?? []) as Array<{ attributes: Beacon }>;
    const meta = r.data?.meta as { count?: number } | undefined;
    return {
      props: {
        initialRows: data.map((d) => d.attributes),
        initialTotal: typeof meta?.count === 'number' ? meta.count : null,
        initialStatus: status,
      },
    };
  } catch {
    return { props: { initialRows: [], initialTotal: null, initialStatus: status } };
  }
};
