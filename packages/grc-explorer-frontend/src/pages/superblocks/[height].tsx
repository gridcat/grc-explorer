import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { api, notFoundOrRethrow } from '../../lib/api';
import { formatCompact, formatNumber, formatTime } from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { CpidLabel } from '../../components/CpidLabel';
import { useCpidNames } from '../../hooks/useCpidNames';

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
  initialProjects: ProjectRow[];
  initialBlockTime: number | null;
  initialActiveBeaconCount: number | null;
  initialCpidNames: Record<string, string>;
}

export default function SuperblockDetail({
  initialSb, initialMagnitudes, initialProjects, initialBlockTime, initialActiveBeaconCount,
  initialCpidNames,
}: SuperblockDetailProps) {
  const router = useRouter();
  const { height } = router.query;
  const [sb, setSb] = useState<Superblock | null>(initialSb);
  const [magnitudes, setMagnitudes] = useState<MagnitudeRow[]>(initialMagnitudes);
  const [projects, setProjects] = useState<ProjectRow[]>(initialProjects);
  const [blockTime, setBlockTime] = useState<number | null>(initialBlockTime);
  const [activeBeaconCount, setActiveBeaconCount] = useState<number | null>(initialActiveBeaconCount);

  // Ref guard so post-fetch setSb doesn't re-trigger the effect.
  const lastFetchedRef = useRef<string | null>(initialSb ? String(initialSb.height) : null);
  useEffect(() => {
    if (!height) return;
    const key = String(height);
    if (lastFetchedRef.current === key) return;
    lastFetchedRef.current = key;
    api.get(`/superblocks/${height}`).then((r) => {
      setSb(r.data?.data?.attributes ?? null);
      setMagnitudes(r.data?.magnitudes ?? []);
      setProjects(r.data?.projects ?? []);
      setBlockTime(r.data?.blockTime ?? null);
      setActiveBeaconCount(r.data?.activeBeaconCount ?? null);
    }).catch(() => { /* ignore */ });
  }, [height]);

  const names = useCpidNames(magnitudes.map((m) => m.cpid), initialCpidNames);

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
              User rewards · per-CPID magnitudes ({magnitudes.length})
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
                      <CpidLabel cpid={m.cpid} name={names.get(m.cpid)} />
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
    const r = await api.get(`/superblocks/${height}`);
    const attrs = r.data?.data?.attributes as Superblock | undefined;
    if (!attrs) return { notFound: true };
    const magnitudes = (r.data?.magnitudes ?? []) as MagnitudeRow[];
    // Names come server-side on each magnitude row now (displayName);
    // seed useCpidNames from them instead of a second /cpids/names call.
    const initialCpidNames: Record<string, string> = {};
    for (const m of magnitudes) {
      if (m.displayName) initialCpidNames[m.cpid] = m.displayName;
    }
    return {
      props: {
        initialSb: attrs,
        initialMagnitudes: magnitudes,
        initialProjects: r.data?.projects ?? [],
        initialBlockTime: r.data?.blockTime ?? null,
        initialActiveBeaconCount: r.data?.activeBeaconCount ?? null,
        initialCpidNames,
      },
    };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};

