import {
  Box, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Fragment, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useRechartsXZoom } from '../../components/charts/useRechartsXZoom';
import { ZoomResetButton } from '../../components/charts/useXZoom';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { Stat } from '../../components/Stat';
import { api, notFoundOrRethrow } from '../../lib/api';
import {
  formatCompact, formatGrc, formatNumber, formatTime, shortHash,
} from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { makeRechartsTooltip } from '../../components/charts/RechartsTooltip';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { CopyLinkButton } from '../../components/CopyLinkButton';

interface CpidSummary {
  cpid: string;
  /** Preferred BOINC display name (highest-credit project that
   *  publishes one); null when nothing is known or the user opted
   *  out via the denylist. */
  displayName: string | null;
  currentMagnitude: number;
  /** Current position in the magnitude leaderboard (1 = top). Null
   *  when the CPID has no magnitude in the latest superblock. */
  currentRank: number | null;
  blocksStaked: number;
  beaconCount: number;
  firstClaimAt: number | null;
  /** Unix-seconds time of the first claim's block. Null when the CPID
   *  has no claims indexed yet. */
  firstClaimTime: number | null;
  lastClaimAt: number | null;
  lastClaimTime: number | null;
}
interface CpidNameEntry {
  projectName: string;
  name: string;
  totalCredit: number;
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
interface LinkedWallet {
  address: string;
  balance?: string;
  beaconCount: number;
  stakedBlocks: number;
  mrcPayouts: number;
  firstHeight: number;
  lastHeight: number;
}

interface CpidDetailProps {
  initialSummary: CpidSummary | null;
  initialClaims: ClaimEntry[];
  initialMagnitudes: MagPoint[];
  initialBeacons: Beacon[];
  initialMrcs: MrcEntry[];
  initialNames: CpidNameEntry[];
  initialLinkedWallets: LinkedWallet[];
  initialCombinedBalance: string;
  initialCombinedSharePct: number;
  initialCombinedCount: number;
}

export default function CpidDetail({
  initialSummary, initialClaims, initialMagnitudes, initialBeacons, initialMrcs, initialNames,
  initialLinkedWallets, initialCombinedBalance, initialCombinedSharePct, initialCombinedCount,
}: CpidDetailProps) {
  const theme = useTheme();
  const magnitudeZoom = useRechartsXZoom('z');
  const router = useRouter();
  const { cpid } = router.query;
  const [summary, setSummary] = useState<CpidSummary | null>(initialSummary);
  const [claims, setClaims] = useState<ClaimEntry[]>(initialClaims);
  const [magnitudes, setMagnitudes] = useState<MagPoint[]>(initialMagnitudes);
  const [beacons, setBeacons] = useState<Beacon[]>(initialBeacons);
  const [mrcs, setMrcs] = useState<MrcEntry[]>(initialMrcs);
  const [names, setNames] = useState<CpidNameEntry[]>(initialNames);
  const [linkedWallets, setLinkedWallets] = useState<LinkedWallet[]>(initialLinkedWallets);
  const [combined, setCombined] = useState({
    balance: initialCombinedBalance,
    sharePct: initialCombinedSharePct,
    count: initialCombinedCount,
  });

  // Ref guard so the post-fetch setSummary doesn't re-trigger the
  // effect via the prior `[cpid, summary]` deps (was a 2-pass waste).
  const lastFetchedRef = useRef<string | null>(initialSummary?.cpid ?? null);
  useEffect(() => {
    if (typeof cpid !== 'string' || !cpid) return;
    if (lastFetchedRef.current === cpid) return;
    lastFetchedRef.current = cpid;
    api.get(`/cpids/${cpid}`).then((r) => {
      setSummary(r.data?.data?.attributes ?? null);
      setClaims(r.data?.claims ?? []);
      setMagnitudes(r.data?.magnitudes ?? []);
      setBeacons(r.data?.beacons ?? []);
      setMrcs(r.data?.mrcs ?? []);
      setNames(r.data?.names ?? []);
      setLinkedWallets(r.data?.linkedWallets ?? []);
      setCombined({
        balance: r.data?.combinedBalance ?? '0',
        sharePct: r.data?.combinedSharePct ?? 0,
        count: r.data?.combinedCount ?? 0,
      });
    }).catch(() => { /* ignore */ });
  }, [cpid]);

  // Collapse the secondary `names` rows to one entry per distinct
  // username, collecting the projects that publish each. Skips
  // names[0] (the primary, shown in the header) so the section
  // doesn't echo the displayName. Backend ships rows sorted by
  // total_credit desc; Map's insertion-order iteration preserves
  // that ranking.
  const groupedOtherNames = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const n of names.slice(1)) {
      const projects = groups.get(n.name);
      if (projects) projects.push(n.projectName);
      else groups.set(n.name, [n.projectName]);
    }
    return Array.from(groups, ([name, projects]) => ({ name, projects }));
  }, [names]);
  const visibleOtherNames = groupedOtherNames.slice(0, 5);
  const remainingGroupCount = Math.max(0, groupedOtherNames.length - 5);

  if (!summary) return <Layout><Typography>Loading…</Typography></Layout>;

  return (
    <>
      <Seo
        title={`Researcher ${summary.displayName ?? summary.cpid} · Gridcoin Block Explorer`}
        description={`Research rewards, magnitude, projects and beacon history for Gridcoin CPID ${summary.cpid}.`}
        path={`/cpids/${summary.cpid}`}
      />
      <Layout>
      <Stack spacing={2}>
        <Crumbs
          items={[
            RESEARCHERS_CRUMB,
            { label: 'CPIDs', href: '/cpids/cohorts' },
            { label: shortHash(summary.cpid, 8, 6) },
          ]}
          trailing={<CopyLinkButton />}
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'baseline' } }}>
          {summary.displayName ? (
            <>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                {summary.displayName}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                CPID {summary.cpid}
              </Typography>
            </>
          ) : (
            <Typography variant="h5" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>
              CPID {summary.cpid}
            </Typography>
          )}
        </Stack>
        {visibleOtherNames.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            Also known as:{' '}
            {visibleOtherNames.map((g, i) => (
              <span key={g.name}>
                {i > 0 && ', '}
                {g.name}
                <span style={{ opacity: 0.6 }}>
                  {' ('}
                  {g.projects.map((p, j) => (
                    <Fragment key={p}>
                      {j > 0 && ', '}
                      <Link href={`/projects/${encodeURIComponent(p)}`} style={{ color: 'inherit' }}>
                        {p}
                      </Link>
                    </Fragment>
                  ))}
                  {')'}
                </span>
              </span>
            ))}
            {remainingGroupCount > 0 ? `, and ${remainingGroupCount} more` : null}
          </Typography>
        )}

        {/* One row: related metrics merged into a single card each
            (magnitude+its rank; staking+beacons) so the conditional
            combined-balance card never spills onto a second row. Grid
            column count is exact, so it's always a single row on md. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, 1fr)',
              md: `repeat(${linkedWallets.length > 0 ? 4 : 3}, 1fr)`,
            },
          }}
        >
          <Stat
            label="Magnitude"
            value={(
              <>
                {summary.currentMagnitude.toFixed(2)}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  {summary.currentRank !== null ? `Rank #${formatNumber(summary.currentRank)}` : 'Unranked'}
                </Typography>
              </>
            )}
          />
          <Stat
            label="On-chain activity"
            value={(
              <>
                {`${formatNumber(summary.blocksStaked)} staked`}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  {`${formatNumber(summary.beaconCount)} beacon(s)`}
                </Typography>
              </>
            )}
          />
          <Stat
            label="Active since"
            value={summary.firstClaimAt ? (
              <>
                <span>{`#${formatNumber(summary.firstClaimAt)}`}</span>
                {summary.firstClaimTime && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.25 }}
                  >
                    {formatTime(summary.firstClaimTime)}
                  </Typography>
                )}
              </>
            ) : '—'}
          />
          {linkedWallets.length > 0 && (
            <Stat
              label="Combined balance"
              value={(
                <>
                  {formatGrc(combined.balance)} GRC
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    {combined.sharePct}% of supply · {combined.count} addresses (cluster)
                  </Typography>
                </>
              )}
            />
          )}
        </Box>

        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle2" color="text.secondary">Magnitude history</Typography>
            <Box sx={{ position: 'relative' }}>
            <ZoomResetButton zoom={magnitudeZoom} />
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={[...magnitudes].reverse()}
                onMouseDown={magnitudeZoom.onMouseDown}
                onMouseMove={magnitudeZoom.onMouseMove}
                onMouseUp={magnitudeZoom.onMouseUp}
                style={{ cursor: 'crosshair' }}
              >
                <XAxis
                  dataKey="superblockHeight"
                  type="number"
                  domain={magnitudeZoom.domain ?? ['dataMin', 'dataMax']}
                  allowDataOverflow
                  fontSize={11}
                />
                <YAxis fontSize={11} />
                <Tooltip
                  cursor={{ stroke: theme.palette.divider, strokeDasharray: '3 3' }}
                  content={<MagnitudeTooltip />}
                />
                <Line type="monotone" dataKey="magnitude" stroke={theme.palette.primary.main} strokeWidth={2} dot={false} />
                {magnitudeZoom.refLeft !== null && magnitudeZoom.refRight !== null && (
                  <ReferenceArea
                    x1={magnitudeZoom.refLeft}
                    x2={magnitudeZoom.refRight}
                    strokeOpacity={0.3}
                    fill={theme.palette.primary.main}
                    fillOpacity={0.12}
                  />
                )}
                {magnitudeZoom.marker !== null && (
                  <ReferenceLine
                    x={magnitudeZoom.marker}
                    stroke={theme.palette.secondary.main}
                    strokeDasharray="2 3"
                    strokeWidth={1.5}
                    ifOverflow="hidden"
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
            </Box>
          </CardContent>
        </Card>

        {/* Recent claims (block-level reward log) pairs with Linked
            wallets (address-level identity log) — both are "what has
            this CPID done?" lenses, just at different cardinalities.
            Grid collapses when there are no linked wallets so the
            claims paper goes full-width. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: linkedWallets.length > 0 ? '1fr 1fr' : '1fr' },
            alignItems: 'start',
          }}
        >
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Recent claims</Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Block</TableCell>
                  <TableCell align="right">Reward</TableCell>
                  <TableCell align="right">Magnitude</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {claims.map((c) => (
                  <TableRow key={c.blockHeight} hover>
                    <TableCell>
                      <Link href={`/block/${c.blockHeight}`} style={{ color: 'inherit' }}>{c.blockHeight}</Link>
                      {c.organization && (
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled', fontSize: 10 }}>
                          {c.organization}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Box
                        component="span"
                        title={`research reward: ${c.researchSubsidy}`}
                      >
                        {formatGrc(c.blockSubsidy)}
                        <Box
                          component="span"
                          sx={{ color: 'text.disabled', fontSize: 11, ml: 0.75 }}
                        >
                          {`+${formatGrc(c.researchSubsidy)} research`}
                        </Box>
                      </Box>
                    </TableCell>
                    <TableCell align="right">{c.magnitude.toFixed(2)}</TableCell>
                    <TableCell>{c.isMrc && <Chip label="MRC" size="small" />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>

          {linkedWallets.length > 0 && (
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
                Linked wallets ({linkedWallets.length})
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, pb: 1 }}>
                Addresses that have provably acted as this CPID on-chain:
                registered as a beacon, signed a coinstake under this CPID,
                or received an MRC payout for it.
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Address</TableCell>
                    <TableCell align="right">Balance</TableCell>
                    <TableCell>Activity</TableCell>
                    <TableCell>Block range</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {linkedWallets.map((w) => (
                    <TableRow key={w.address} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        <Link href={`/addresses/${w.address}`} style={{ color: 'inherit' }}>
                          <HashTrim text={w.address} head={8} tail={6} />
                        </Link>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {formatGrc(w.balance ?? '0')} GRC
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }} title={activityTooltip(w)}>
                        {activitySummary(w)}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {blockRange(w.firstHeight, w.lastHeight)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Combined</TableCell>
                    <TableCell
                      align="right"
                      sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}
                      title={`${combined.sharePct}% of money supply`}
                    >
                      {formatGrc(combined.balance)} GRC
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableBody>
              </Table>
            </Paper>
          )}
        </Box>

        {/* Beacon history + MRC requests pair side-by-side on desktop:
            both are address-/tx-level audit logs scoped to this CPID.
            Grid collapses to one column when one of them is empty so
            the surviving paper doesn't shrink to half-width for no
            reason. */}
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: mrcs.length > 0 ? '1fr 1fr' : '1fr' },
            alignItems: 'start',
          }}
        >
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
        </Box>
      </Stack>
      </Layout>
    </>
  );
}

const MagnitudeTooltip = makeRechartsTooltip((payload, label) => {
  const point = payload[0]?.payload as { superblockHeight?: number } | undefined;
  const value = Number(payload[0]?.value ?? 0);
  const sb = point?.superblockHeight ?? label;
  return {
    title: `Superblock #${typeof sb === 'number' ? formatNumber(sb) : String(sb ?? '?')}`,
    rows: [{ label: 'Magnitude', value: value.toFixed(2) }],
  };
});

// Compact "Activity" summary for a linked wallet — drops zero-count
// signals so a beacon-only wallet doesn't render "0 stakes · 0 mrc".
function activitySummary(w: { beaconCount: number; stakedBlocks: number; mrcPayouts: number }): string {
  const parts: string[] = [];
  if (w.beaconCount > 0) parts.push(`${formatCompact(w.beaconCount, 0)} bcn`);
  if (w.stakedBlocks > 0) parts.push(`${formatCompact(w.stakedBlocks, 0)} stk`);
  if (w.mrcPayouts > 0) parts.push(`${formatCompact(w.mrcPayouts, 0)} mrc`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function activityTooltip(w: { beaconCount: number; stakedBlocks: number; mrcPayouts: number }): string {
  const parts: string[] = [];
  if (w.beaconCount > 0) parts.push(`${formatNumber(w.beaconCount)} beacons`);
  if (w.stakedBlocks > 0) parts.push(`${formatNumber(w.stakedBlocks)} staked blocks`);
  if (w.mrcPayouts > 0) parts.push(`${formatNumber(w.mrcPayouts)} MRC payouts`);
  return parts.join(', ');
}

function blockRange(first: number, last: number): string {
  if (first === last) return `#${formatNumber(first)}`;
  return `#${formatNumber(first)} – #${formatNumber(last)}`;
}

// 32 lowercase hex chars — same shape the backend validates. Used to
// distinguish "looks like a CPID, fetch it" from "looks like a
// username, resolve it first" in the SSR path.
const CPID_HEX_RE = /^[0-9a-f]{32}$/;

// Wallet's MiningId::Parse (src/gridcoin/cpid.cpp) maps these strings
// to the Noncruncher sentinel — i.e. "no CPID, staked as investor".
// They are not real CPIDs and won't resolve via the names index, so
// short-circuit to the researchers-vs-investors breakdown instead of
// 404'ing.
const NONCRUNCHER_ALIASES = new Set(['noncruncher', 'non-cruncher', 'investor']);

export const getServerSideProps: GetServerSideProps<CpidDetailProps> = async (ctx) => {
  const { cpid } = ctx.params ?? {};
  if (typeof cpid !== 'string') return { notFound: true };
  const param = cpid.trim();
  if (NONCRUNCHER_ALIASES.has(param.toLowerCase())) {
    return {
      redirect: { destination: '/network/stakers', permanent: false },
    };
  }
  // If the URL param looks like a BOINC username (or anything that
  // isn't a 32-char lowercase hex CPID), resolve it via the names
  // index and 302 to the canonical /cpids/<hex> URL. Lets users (and
  // crawlers) reach a researcher by typing /cpids/<username>.
  if (!CPID_HEX_RE.test(param.toLowerCase())) {
    try {
      const r = await api.get('/cpids/resolve', { params: { name: param } });
      const matches = (r.data?.data?.attributes?.matches ?? []) as Array<{ cpid: string }>;
      if (matches.length > 0) {
        return {
          redirect: {
            destination: `/cpids/${matches[0].cpid}`,
            permanent: false,
          },
        };
      }
    } catch (err) {
      // A genuine "no such name" 404 → notFound; a transient resolver
      // failure (timeout/5xx) must NOT masquerade as a permanent 404,
      // so rethrow and let Next render its error page.
      return notFoundOrRethrow(err);
    }
    return { notFound: true };
  }
  try {
    const r = await api.get(`/cpids/${param.toLowerCase()}`);
    const attrs = r.data?.data?.attributes as CpidSummary | undefined;
    if (!attrs) return { notFound: true };
    return {
      props: {
        initialSummary: attrs,
        initialClaims: r.data?.claims ?? [],
        initialMagnitudes: r.data?.magnitudes ?? [],
        initialBeacons: r.data?.beacons ?? [],
        initialMrcs: r.data?.mrcs ?? [],
        initialNames: r.data?.names ?? [],
        initialLinkedWallets: r.data?.linkedWallets ?? [],
        initialCombinedBalance: (r.data?.combinedBalance ?? '0') as string,
        initialCombinedSharePct: (r.data?.combinedSharePct ?? 0) as number,
        initialCombinedCount: (r.data?.combinedCount ?? 0) as number,
      },
    };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};

