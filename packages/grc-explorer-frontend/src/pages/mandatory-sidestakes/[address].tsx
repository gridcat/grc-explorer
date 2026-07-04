import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { Crumbs } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { api, notFoundOrRethrow } from '../../lib/api';
import { formatGrc, formatNumber, formatTime } from '../../lib/format';

interface RegistryEvent {
  action: 'A' | 'D';
  status: 'MANDATORY' | 'DELETED';
  allocationPct: number;
  description: string;
  txId: string;
  blockHeight: number;
  time: number;
}

interface Payout {
  blockHeight: number;
  voutIdx: number;
  txId: string;
  amount: string;
  time: number;
}

interface RecipientDetail {
  address: string;
  currentStatus: 'MANDATORY' | 'DELETED' | string;
  currentAllocationPct: number;
  currentDescription: string;
  totalPaid: string;
  payoutCount: number;
  registry: RegistryEvent[];
  payouts: Payout[];
}

interface PageProps {
  initial: RecipientDetail | null;
}

export default function RecipientDetailPage({ initial }: PageProps) {
  if (!initial) {
    return (
      <Layout>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>
          Sidestake recipient not found
        </Typography>
        <Typography variant="body2" color="text.secondary">
          This address has never been registered as a mandatory sidestake destination.
        </Typography>
      </Layout>
    );
  }

  const isMandatory = initial.currentStatus === 'MANDATORY';

  return (
    <Layout>
      <Seo
        title={`${initial.address} — mandatory sidestake recipient`}
        description={`Mandatory sidestake registry + payout history for ${initial.address}. Current allocation ${initial.currentAllocationPct.toFixed(2)}%.`}
        path={`/mandatory-sidestakes/${initial.address}`}
      />

      <Stack spacing={3}>
        <Crumbs items={[
          { label: 'Mandatory sidestakes', href: '/mandatory-sidestakes' },
          { label: 'Recipient' },
        ]}
        />

        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {initial.address}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
            <Chip
              size="small"
              label={isMandatory ? 'active recipient' : 'deleted'}
              color={isMandatory ? 'success' : 'default'}
              variant={isMandatory ? 'filled' : 'outlined'}
            />
            {initial.currentDescription && (
              <Chip size="small" label={initial.currentDescription} variant="outlined" />
            )}
            <Typography variant="body2" color="text.secondary">
              <Link href={`/addresses/${initial.address}`} style={{ color: 'inherit' }}>
                View wallet history →
              </Link>
            </Typography>
          </Stack>
        </Box>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap' }}
        >
          <Stat label="Allocation" value={`${initial.currentAllocationPct.toFixed(2)}%`} />
          <Stat
            label="Lifetime received"
            value={`${formatGrc(initial.totalPaid)} GRC`}
            accent="success"
          />
          <Stat label="Payouts" value={formatNumber(initial.payoutCount)} />
        </Stack>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle1" sx={{ p: 2, fontWeight: 700 }}>
            Registry lifecycle
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Action</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Allocation</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Tx</TableCell>
                <TableCell>Block</TableCell>
                <TableCell>Time</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {initial.registry.map((r) => (
                <TableRow key={`${r.blockHeight}-${r.txId}`} hover>
                  <TableCell>
                    <Chip size="small" label={r.action === 'A' ? 'add' : 'delete'} color={r.action === 'A' ? 'success' : 'default'} variant="outlined" />
                  </TableCell>
                  <TableCell>{r.status}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {`${r.allocationPct.toFixed(2)}%`}
                  </TableCell>
                  <TableCell>{r.description || '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/transactions/${r.txId}`} style={{ color: 'inherit' }}>
                      <HashTrim text={r.txId} head={8} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/block/${r.blockHeight}`} style={{ color: 'inherit' }}>
                      {`#${formatNumber(r.blockHeight)}`}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(r.time)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle1" sx={{ p: 2, fontWeight: 700 }}>
            Recent payouts
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              (last 200)
            </Typography>
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Block</TableCell>
                <TableCell>Tx</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell>Time</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {initial.payouts.map((p) => (
                <TableRow key={`${p.blockHeight}-${p.voutIdx}`} hover>
                  <TableCell>
                    <Link href={`/block/${p.blockHeight}`} style={{ color: 'inherit' }}>
                      {`#${formatNumber(p.blockHeight)}`}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/transactions/${p.txId}`} style={{ color: 'inherit' }}>
                      <HashTrim text={p.txId} head={8} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {`${formatGrc(p.amount)} GRC`}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(p.time)}
                  </TableCell>
                </TableRow>
              ))}
              {initial.payouts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No payouts to this recipient yet.
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
  label, value, accent,
}: {
  label: string;
  value: string | number;
  accent?: 'success' | 'warning';
}) {
  let color: string = 'text.primary';
  if (accent === 'success') color = 'success.main';
  if (accent === 'warning') color = 'warning.main';
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 160 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {label}
        </Typography>
        <Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const { address } = ctx.params ?? {};
  if (typeof address !== 'string') return { notFound: true };
  try {
    const r = await api.get(`/mandatory-sidestakes/${address}`);
    const attrs = r.data?.data?.attributes as RecipientDetail | undefined;
    if (!attrs) return { notFound: true };
    return { props: { initial: attrs } };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};
