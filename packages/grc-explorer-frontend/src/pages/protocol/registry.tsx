import {
  Alert, Box, Chip, Container, Paper, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { Crumbs } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { IS_TESTNET } from '../../lib/network';

interface RegistryEvent {
  value: string;
  status: 'ACTIVE' | 'DELETED' | string;
  block_height: number;
  time: number;
  tx_id: string;
  previous_hash: string;
  contract_version: number;
}

interface RegistryKey {
  key: string;
  current_value: string | null;
  current_set_at_height: number | null;
  current_set_at_time: number | null;
  events: RegistryEvent[];
}

interface ProtocolRegistryPageProps {
  keys: RegistryKey[];
}

const PAGE_TITLE = IS_TESTNET
  ? '[testnet] Gridcoin protocol registry — on-chain parameter history'
  : 'Gridcoin protocol registry — on-chain parameter history';

const PAGE_DESCRIPTION = 'Time-travel viewer for the Gridcoin on-chain '
  + 'protocol-parameter registry. Every ADD and DELETE event for every '
  + 'key — including the V13+ magnitudeweightfactor that drives the '
  + 'BALANCE_AND_MAGNITUDE poll-weight formula. The only place this '
  + 'lives on the web outside the Gridcoin source tree.';

export default function ProtocolRegistryPage({ keys }: ProtocolRegistryPageProps) {
  return (
    <Layout showTimeMachine={false}>
      <Head>
        <title>{PAGE_TITLE}</title>
        <meta name="description" content={PAGE_DESCRIPTION} />
        <link rel="canonical" href="/protocol/registry" />
      </Head>
      <Container maxWidth="lg" sx={{ flexGrow: 1, py: 2 }}>
        <Stack spacing={3}>
          <Crumbs items={[
            { label: 'Protocol', href: '/protocol' },
            { label: 'Registry' },
          ]}
          />
          <Box>
            <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
              Protocol registry
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              The Gridcoin wallet maintains an on-chain key/value
              registry for protocol parameters that can be tuned
              without a hard fork. Each contract is either an{' '}
              <Chip size="small" label="ACTIVE" color="success" variant="outlined" />
              {' '}ADD or a{' '}
              <Chip size="small" label="DELETED" color="default" variant="outlined" />
              {' '}DELETE; the wallet replays every event in chain
              order to build the live state. The most audit-relevant
              key today is{' '}
              <code>magnitudeweightfactor</code>, which drives
              {' '}
              <Link href="/protocol#v13" style={{ color: 'inherit' }}>V13</Link>+
              poll weighting for the
              {' '}<code>BALANCE_AND_MAGNITUDE</code>{' '}
              vote-weight type.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Source:{' '}
              <a
                href="https://github.com/gridcoin-community/Gridcoin-Research/blob/development/src/gridcoin/protocol.cpp"
                rel="noopener noreferrer"
                style={{ color: 'inherit' }}
              >
                src/gridcoin/protocol.cpp
              </a>
              {' '}—{' '}
              <code>ProtocolRegistry</code>{' '}is populated by replaying every
              {' '}<code>type: &quot;protocol&quot;</code>{' '}contract on chain.
            </Typography>
          </Box>

          {keys.length === 0 && (
            <Alert severity="info">
              No protocol-registry events indexed yet. The first key
              expected on mainnet is{' '}
              <code>magnitudeweightfactor</code>, which only takes
              effect from V13 (block 3,989,800). Until then, polls use
              the hardcoded
              {' '}<code>DefaultMagnitudeWeightFactor</code>{' '}
              from chainparams (100/567).
            </Alert>
          )}

          {keys.map((k) => (
            <Paper key={k.key} variant="outlined" sx={{ overflow: 'hidden' }}>
              <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
                <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Typography variant="h6" sx={{ fontWeight: 700, fontFamily: 'var(--font-mono, monospace)' }}>
                    {k.key}
                  </Typography>
                  {k.current_value !== null ? (
                    <>
                      <Typography variant="body2" color="text.secondary">Current value</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                        {k.current_value}
                      </Typography>
                      {k.current_set_at_height !== null && (
                        <Typography variant="caption" color="text.secondary">
                          set at{' '}
                          <Link href={`/block/${k.current_set_at_height}`} style={{ color: 'inherit' }}>
                            #{k.current_set_at_height.toLocaleString()}
                          </Link>
                          {k.current_set_at_time !== null && (
                            <>{' '}({formatTime(k.current_set_at_time)})</>
                          )}
                        </Typography>
                      )}
                    </>
                  ) : (
                    <Chip size="small" label="no active value" variant="outlined" />
                  )}
                </Stack>
              </Box>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Status</TableCell>
                    <TableCell>Value</TableCell>
                    <TableCell align="right">Block</TableCell>
                    <TableCell>When</TableCell>
                    <TableCell>Tx</TableCell>
                    <TableCell>Prev</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {k.events.map((e) => (
                    <TableRow key={e.tx_id} hover>
                      <TableCell>
                        <Chip
                          size="small"
                          label={e.status}
                          color={e.status === 'ACTIVE' ? 'success' : 'default'}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}>
                        {e.value}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        <Link href={`/block/${e.block_height}`} style={{ color: 'inherit' }}>
                          {e.block_height.toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                        {formatTime(e.time)}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
                        <Link href={`/tx/${e.tx_id}`} style={{ color: 'inherit' }}>
                          <HashTrim text={e.tx_id} head={8} tail={4} />
                        </Link>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'text.secondary' }}>
                        {e.previous_hash && !/^0+$/.test(e.previous_hash) ? (
                          <HashTrim text={e.previous_hash} head={6} tail={4} />
                        ) : (
                          <em>—</em>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          ))}
        </Stack>
      </Container>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<ProtocolRegistryPageProps> = async () => {
  try {
    const r = await api.get('/network/protocol-entries');
    const keys = (r.data?.data?.attributes?.keys ?? []) as RegistryKey[];
    return { props: { keys } };
  } catch {
    return { props: { keys: [] } };
  }
};
