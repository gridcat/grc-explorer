import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { api, notFoundOrRethrow } from '../../lib/api';
import { formatCompact, formatNumber, formatTime } from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { CpidLabel } from '../../components/CpidLabel';

interface Superblock {
  height: number;
  quorumHash: string;
  totalMagnitude: number;
  cpidCount: number;
  projectCount: number;
}
interface MagnitudeRow { cpid: string; magnitude: number; displayName?: string | null }
interface ProjectRow {
  projectName: string;
  averageRac: number;
  rac: number;
  totalCredit: number;
}

interface SuperblockDetailProps {
  initialSb: Superblock | null;
  initialMagnitudes: MagnitudeRow[];
  // Total magnitude rows for this superblock. initialMagnitudes may be a
  // truncated top-N prefix (see getServerSideProps) to keep the SSR payload
  // small; when it's short of the total the client fetches the full list.
  initialMagnitudeTotal: number;
  initialProjects: ProjectRow[];
  initialBlockTime: number | null;
  initialActiveBeaconCount: number | null;
}

export default function SuperblockDetail({
  initialSb, initialMagnitudes, initialMagnitudeTotal, initialProjects, initialBlockTime,
  initialActiveBeaconCount,
}: SuperblockDetailProps) {
  const router = useRouter();
  const { height } = router.query;
  const [magnitudes, setMagnitudes] = useState<MagnitudeRow[]>(initialMagnitudes);
  const [activeBeaconCount, setActiveBeaconCount] = useState<number | null>(initialActiveBeaconCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const sb = initialSb;
  const projects = initialProjects;
  const blockTime = initialBlockTime;

  // Sync state on client-side navigation between dynamic superblock routes.
  useEffect(() => {
    setMagnitudes(initialMagnitudes);
    setActiveBeaconCount(initialActiveBeaconCount);
    setLoadingMore(false);
  }, [initialSb?.height, initialMagnitudes, initialActiveBeaconCount]);

  // This cosmetic count has a comparatively expensive cold path. Fetch it
  // after first paint rather than making SSR wait for it.
  useEffect(() => {
    if (!height || initialActiveBeaconCount !== null) return undefined;
    let cancelled = false;
    api.get(`/superblocks/${height}/active-beacon-count`).then((r) => {
      if (!cancelled) setActiveBeaconCount(r.data?.data?.attributes?.count ?? null);
    }).catch(() => { /* keep the non-blocking placeholder */ });
    return () => { cancelled = true; };
  }, [height, initialActiveBeaconCount]);

  const loadMoreMagnitudes = () => {
    if (!height || loadingMore || magnitudes.length >= initialMagnitudeTotal) return;
    const offset = magnitudes.length;
    setLoadingMore(true);
    api.get(`/superblocks/${height}/magnitudes`, {
      params: { offset, limit: 200 },
    }).then((r) => {
      const next = (r.data?.data?.attributes?.magnitudes ?? []) as MagnitudeRow[];
      setMagnitudes((current) => (current.length === offset ? [...current, ...next] : current));
    }).catch(() => { /* retain the rows already rendered */ }).finally(() => {
      setLoadingMore(false);
    });
  };

  if (!sb) return <Layout><Typography>Loading…</Typography></Layout>;

  return (
    <>
      <Seo
        title={`Superblock #${formatNumber(sb.height)} · Gridcoin Block Explorer`}
        description={`Project magnitudes, totals and details for the Gridcoin superblock at height ${sb.height}.`}
        path={`/superblocks/${sb.height}`}
      />
      <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'Superblocks', href: '/superblocks' },
          { label: `#${formatNumber(sb.height)}` },
        ]}
        />
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Superblock #{formatNumber(sb.height)}
          </Typography>
          <Chip label="superblock" color="secondary" sx={{ fontWeight: 700 }} />
          <Chip
            label={(
              <Link href={`/block/${sb.height}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                view block details →
              </Link>
            )}
            size="small"
            variant="outlined"
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Superblocks anchor the per-CPID magnitude payouts. Every ~24 hours
          the Gridcoin scraper quorum agrees on a snapshot of every BOINC
          project&apos;s credit and every researcher&apos;s contribution; the
          winning staker embeds it in a regular block, becoming this
          superblock. Subsequent claims pay research rewards using this
          magnitude table until the next superblock supersedes it.
        </Typography>

        <Card variant="outlined">
          <CardContent>
            <Stack
              direction="row"
              spacing={4}
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              <Stat label="Block time" value={blockTime ? formatTime(blockTime) : '—'} />
              <Stat label="Quorum hash" value={sb.quorumHash ? <HashTrim text={sb.quorumHash} /> : '—'} mono />
              <Stat label="Total magnitude" value={sb.totalMagnitude.toFixed(2)} />
              <Stat label="Researchers paid" value={formatNumber(sb.cpidCount)} />
              <Stat label="Projects active" value={String(sb.projectCount)} />
              <Stat
                label="Verified beacons"
                value={activeBeaconCount === null ? '—' : formatNumber(activeBeaconCount)}
              />
            </Stack>
          </CardContent>
        </Card>

        {/* Active projects (4 cols) and User rewards (4 cols) pair
            naturally — both are per-superblock aggregates and let the
            operator cross-read project activity against researcher
            payouts. Grid collapses to one column when projects is
            empty so the magnitudes table doesn't get squeezed. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: projects.length > 0 ? '1fr 1fr' : '1fr' },
            alignItems: 'start',
          }}
        >
          {projects.length > 0 && (
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
                Active projects ({projects.length})
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Project</TableCell>
                    <TableCell align="right">RAC</TableCell>
                    <TableCell align="right">Average RAC</TableCell>
                    <TableCell align="right">Total credit</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow key={p.projectName} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>
                        <Link
                          href={`/projects/${encodeURIComponent(p.projectName)}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {p.projectName}
                        </Link>
                      </TableCell>
                      <TableCell align="right">{compact(p.rac)}</TableCell>
                      <TableCell align="right">{compact(p.averageRac)}</TableCell>
                      <TableCell align="right">{compact(p.totalCredit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          )}

          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
              User rewards · per-CPID magnitudes ({Math.max(magnitudes.length, initialMagnitudeTotal)})
            </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 60 }}>#</TableCell>
                <TableCell>CPID</TableCell>
                <TableCell align="right">Magnitude</TableCell>
                <TableCell align="right">% of total</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {magnitudes.map((m, i) => (
                <TableRow key={m.cpid} hover>
                  <TableCell sx={{ color: 'text.secondary' }}>{i + 1}</TableCell>
                  <TableCell>
                    <Link href={`/cpids/${m.cpid}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {/* Prefer the name carried on the row itself (present
                          in both the SSR seed and the full client fetch) so
                          rows past the SSR top-N don't flash the bare CPID
                          while the shared useCpidNames resolver catches up,
                          and so first render is identical server/client. */}
                      <CpidLabel cpid={m.cpid} name={m.displayName} />
                    </Link>
                  </TableCell>
                  <TableCell align="right">{m.magnitude.toFixed(2)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {sb.totalMagnitude > 0
                      ? `${((m.magnitude / sb.totalMagnitude) * 100).toFixed(2)}%`
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {magnitudes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No magnitude rows captured for this superblock yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {magnitudes.length < initialMagnitudeTotal && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
              <Button onClick={loadMoreMagnitudes} disabled={loadingMore} variant="outlined" size="small">
                {loadingMore
                  ? 'Loading…'
                  : `Load more (${magnitudes.length.toLocaleString()} of ${initialMagnitudeTotal.toLocaleString()})`}
              </Button>
            </Box>
          )}
        </Paper>
        </Box>
      </Stack>
      </Layout>
    </>
  );
}

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontSize: 10.5,
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="h6"
        sx={{ fontFamily: mono ? 'monospace' : undefined, fontWeight: 600, mt: 0.25 }}
      >
        {value}
      </Typography>
    </Box>
  );
}

const compact = (n: number) => formatCompact(n, 2);

export const getServerSideProps: GetServerSideProps<SuperblockDetailProps> = async (ctx) => {
  const { height } = ctx.params ?? {};
  if (typeof height !== 'string') return { notFound: true };
  try {
    const SSR_MAGNITUDE_CAP = 200;
    const r = await api.get(`/superblocks/${height}`, {
      params: { magnitudesLimit: SSR_MAGNITUDE_CAP, includeActiveBeaconCount: false },
    });
    const attrs = r.data?.data?.attributes as Superblock | undefined;
    if (!attrs) return { notFound: true };
    const allMagnitudes = (r.data?.magnitudes ?? []) as MagnitudeRow[];
    // Ship only the top-N (already magnitude-desc) in SSR — a big superblock
    // has ~1200 rows (~150 kB) which blows Next's page-data budget and slows
    // first paint. The client pulls the full list post-hydration (see the
    // effect + magnitudesComplete). Small superblocks ship whole.
    const initialMagnitudes = allMagnitudes.slice(0, SSR_MAGNITUDE_CAP);
    return {
      props: {
        initialSb: attrs,
        initialMagnitudes,
        initialMagnitudeTotal: Number(r.data?.magnitudeTotal ?? allMagnitudes.length),
        initialProjects: r.data?.projects ?? [],
        initialBlockTime: r.data?.blockTime ?? null,
        initialActiveBeaconCount: r.data?.activeBeaconCount ?? null,
      },
    };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};
