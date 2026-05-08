import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import {
  Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Layout } from '../../layouts/Layout';
import { Stat } from '../../components/Stat';
import { api } from '../../lib/api';
import { formatGrc, shortHash } from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';

interface CpidSummary {
  cpid: string;
  currentMagnitude: number;
  blocksStaked: number;
  beaconCount: number;
  firstClaimAt: number | null;
  lastClaimAt: number | null;
}
interface ClaimEntry {
  blockHeight: number;
  organization: string;
  blockSubsidy: string;
  researchSubsidy: string;
  magnitude: number;
  isMrc: boolean;
}
interface MagPoint { superblockHeight: number; magnitude: number }
interface Beacon { address: string; status: string; txId: string; blockHeight: number; expiration: number }
interface MrcEntry {
  txId: string;
  researchSubsidy: string;
  feeOffered: string;
  firstSeen: number;
  blockHeight: number | null;
  blockTime: number | null;
  status: 'pending' | 'confirmed' | 'evicted';
  waitSeconds: number | null;
}

interface CpidDetailProps {
  initialSummary: CpidSummary | null;
  initialClaims: ClaimEntry[];
  initialMagnitudes: MagPoint[];
  initialBeacons: Beacon[];
  initialMrcs: MrcEntry[];
}

export default function CpidDetail({
  initialSummary, initialClaims, initialMagnitudes, initialBeacons, initialMrcs,
}: CpidDetailProps) {
  const theme = useTheme();
  const router = useRouter();
  const { cpid } = router.query;
  const [summary, setSummary] = useState<CpidSummary | null>(initialSummary);
  const [claims, setClaims] = useState<ClaimEntry[]>(initialClaims);
  const [magnitudes, setMagnitudes] = useState<MagPoint[]>(initialMagnitudes);
  const [beacons, setBeacons] = useState<Beacon[]>(initialBeacons);
  const [mrcs, setMrcs] = useState<MrcEntry[]>(initialMrcs);

  useEffect(() => {
    if (!cpid) return;
    if (summary && summary.cpid === cpid) return;
    api.get(`/cpids/${cpid}`).then((r) => {
      setSummary(r.data?.data?.attributes ?? null);
      setClaims(r.data?.claims ?? []);
      setMagnitudes(r.data?.magnitudes ?? []);
      setBeacons(r.data?.beacons ?? []);
      setMrcs(r.data?.mrcs ?? []);
    }).catch(() => { /* ignore */ });
  }, [cpid, summary]);

  if (!summary) return <Layout><Typography>Loading…</Typography></Layout>;

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'CPIDs', href: '/cpids/cohorts' },
          { label: shortHash(summary.cpid, 8, 6) },
        ]}
        />
        <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
          <Typography variant="h5" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>
            CPID {summary.cpid}
          </Typography>
        </Stack>

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' } }}>
          <Stat label="Current magnitude" value={summary.currentMagnitude.toFixed(2)} />
          <Stat label="Blocks staked" value={summary.blocksStaked.toLocaleString()} />
          <Stat label="Beacons" value={String(summary.beaconCount)} />
          <Stat label="Active since" value={summary.firstClaimAt ? `#${summary.firstClaimAt}` : '—'} />
        </Box>

        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle2" color="text.secondary">Magnitude history</Typography>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={[...magnitudes].reverse()}>
                <XAxis dataKey="superblockHeight" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="magnitude" stroke={theme.palette.primary.main} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Recent claims</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Block</TableCell>
                <TableCell>Organization</TableCell>
                <TableCell align="right">Block reward</TableCell>
                <TableCell align="right">Research reward</TableCell>
                <TableCell align="right">Magnitude</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {claims.map((c) => (
                <TableRow key={c.blockHeight} hover>
                  <TableCell>
                    <Link href={`/block/${c.blockHeight}`} style={{ color: 'inherit' }}>{c.blockHeight}</Link>
                  </TableCell>
                  <TableCell>{c.organization}</TableCell>
                  <TableCell align="right">{formatGrc(c.blockSubsidy)}</TableCell>
                  <TableCell align="right">{formatGrc(c.researchSubsidy)}</TableCell>
                  <TableCell align="right">{c.magnitude.toFixed(2)}</TableCell>
                  <TableCell>{c.isMrc && <Chip label="MRC" size="small" />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Beacon history</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Address</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Block</TableCell>
                <TableCell>Expires</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {beacons.map((b) => (
                <TableRow key={b.txId} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/addresses/${b.address}`} style={{ color: 'inherit' }}><HashTrim text={b.address} head={8} tail={6} /></Link>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={b.status}
                      color={b.status === 'active' ? 'success' : b.status === 'revoked' ? 'error' : 'default'}
                    />
                  </TableCell>
                  <TableCell>#{b.blockHeight}</TableCell>
                  <TableCell>{new Date(b.expiration * 1000).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>

        {mrcs.length > 0 && (
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
              MRC requests ({mrcs.length})
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Tx</TableCell>
                  <TableCell align="right">Requested</TableCell>
                  <TableCell align="right">Bid fee</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Block</TableCell>
                  <TableCell align="right">Wait</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mrcs.map((m) => (
                  <TableRow key={m.txId} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      <Link href={`/transactions/${m.txId}`} style={{ color: 'inherit' }}>
                        <HashTrim text={m.txId} head={10} tail={6} />
                      </Link>
                    </TableCell>
                    <TableCell align="right">{formatGrc(m.researchSubsidy)}</TableCell>
                    <TableCell align="right">{formatGrc(m.feeOffered)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={m.status}
                        color={m.status === 'confirmed' ? 'success' : m.status === 'evicted' ? 'default' : 'primary'}
                        variant={m.status === 'pending' ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    <TableCell>
                      {m.blockHeight !== null ? (
                        <Link href={`/block/${m.blockHeight}`} style={{ color: 'inherit' }}>
                          #{m.blockHeight}
                        </Link>
                      ) : <span style={{ opacity: 0.5 }}>—</span>}
                    </TableCell>
                    <TableCell align="right">
                      {m.waitSeconds !== null ? `${m.waitSeconds}s` : <span style={{ opacity: 0.5 }}>—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </Stack>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<CpidDetailProps> = async (ctx) => {
  const { cpid } = ctx.params ?? {};
  if (typeof cpid !== 'string') return { notFound: true };
  try {
    const r = await api.get(`/cpids/${cpid}`);
    const attrs = r.data?.data?.attributes as CpidSummary | undefined;
    if (!attrs) return { notFound: true };
    return {
      props: {
        initialSummary: attrs,
        initialClaims: r.data?.claims ?? [],
        initialMagnitudes: r.data?.magnitudes ?? [],
        initialBeacons: r.data?.beacons ?? [],
        initialMrcs: r.data?.mrcs ?? [],
      },
    };
  } catch {
    return { notFound: true };
  }
};

