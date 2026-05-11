import {
  Box, Button, Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatGrc, formatNumber, formatTime } from '../../lib/format';
import { track } from '../../lib/track';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs } from '../../components/Crumbs';

export interface Block {
  height: number;
  hash: string;
  prevHash: string;
  merkleRoot: string;
  time: number;
  version: number;
  difficulty: string;
  size: number;
  txCount: number;
  isPos: boolean;
  isSuperblock: boolean;
  minerAddress: string | null;
  stakerCpid: string | null;
  mint: string;
  moneySupply: string;
}

export interface ClaimSummary {
  cpid: string | null;
  organization: string;
  client_version: string;
  block_subsidy: string;
  research_subsidy: string;
  magnitude: number;
  is_mrc: boolean;
  mrc_foundation_fees?: string;
  mrc_staker_fees?: string;
}

export interface ClaimMrc {
  cpid: string;
  miningId: string;
  clientVersion: string;
  researchSubsidy: string;
  magnitude: number;
  payToAddress: string | null;
}

export interface BlockDetailProps {
  initialBlock: Block | null;
  initialTransactions: Array<{ txId: string; isCoinbase: boolean; isCoinstake: boolean; totalOut: string; fee: string }>;
  initialClaim: ClaimSummary | null;
  initialMrcs: ClaimMrc[];
  initialTipHeight: number | null;
}

/**
 * Map a block-header `version` to the human-readable Gridcoin era it
 * belongs to. Labels follow the actual consensus forks in
 * `src/chainparams.cpp` + `src/gridcoin/staking/difficulty.cpp` — see
 * `reference_gridcoin_protocol_gates.md` for the full table of what
 * each version-bump activates.
 */
function TxTypeChip({ isCoinbase, isCoinstake }: { isCoinbase: boolean; isCoinstake: boolean }) {
  if (isCoinbase) return <Chip label="coinbase" size="small" />;
  if (isCoinstake) return <Chip label="coinstake" size="small" />;
  return <Chip label="standard" size="small" variant="outlined" />;
}

function blockEraLabel(version: number): string {
  if (version >= 14) return 'v14+ (BIP68 + beacon v3)';
  if (version === 13) return 'v13 (MRC + SBv3)';
  if (version === 12) return 'v12 (stake-time mask)';
  if (version === 11) return 'v11 (Fern / binary contracts)';
  if (version === 10) return 'v10 (sidestake checks)';
  if (version === 9) return 'v9 (V9 tally)';
  if (version === 8) return 'v8 (V8 kernel + 8-decimal subsidy)';
  if (version > 0) return `v${version} (pre-V8 legacy)`;
  return '—';
}

export function BlockDetail({
  initialBlock, initialTransactions, initialClaim, initialMrcs, initialTipHeight,
}: BlockDetailProps) {
  const router = useRouter();
  const { height } = router.query;
  const [block, setBlock] = useState<Block | null>(initialBlock);
  const [transactions, setTransactions] = useState(initialTransactions);
  const [claim, setClaim] = useState<ClaimSummary | null>(initialClaim);
  const [mrcs, setMrcs] = useState<ClaimMrc[]>(initialMrcs);
  // Indexer-tip height comes back with the block payload so the page can
  // hide "Next →" when we're already on the chain tip without making a
  // second request to /network on every render.
  const [tipHeight, setTipHeight] = useState<number | null>(initialTipHeight);

  useEffect(() => {
    if (!height) return;
    // Skip the client-side fetch on the very first render — SSR
    // already populated state. Re-fetch only when the user navigates
    // to a different `height` via Next/Prev (Next.js shallow nav
    // changes the query without re-running getServerSideProps).
    if (block && String(block.height) === String(height)) return;
    api.get(`/blocks/${height}`).then((r) => {
      const attrs = r.data?.data?.attributes as Block | undefined;
      setBlock(attrs ?? null);
      setTransactions(r.data?.transactions ?? []);
      setMrcs(r.data?.mrcs ?? []);
      setTipHeight(typeof r.data?.tipHeight === 'number' ? r.data.tipHeight : null);
      const c = r.data?.claim;
      if (c) {
        setClaim({
          cpid: c.cpid,
          organization: c.organization,
          client_version: c.client_version,
          block_subsidy: c.block_subsidy?.toString() ?? '0',
          research_subsidy: c.research_subsidy?.toString() ?? '0',
          magnitude: c.magnitude ?? 0,
          is_mrc: !!c.is_mrc,
          mrc_foundation_fees: c.mrc_foundation_fees?.toString() ?? '0',
          mrc_staker_fees: c.mrc_staker_fees?.toString() ?? '0',
        });
      }
    }).catch(() => { /* ignore */ });
  }, [height, block]);

  if (!block) return <Layout><Typography>Loading…</Typography></Layout>;

  // Edge handling: hide "← Prev" at the genesis block and "Next →" once
  // the user has reached the latest indexed block. Anything in between
  // gets both. We rely on `tipHeight` from the server payload — if that
  // is somehow missing (older API), we conservatively keep "Next →"
  // visible so the user is never stuck.
  const hasPrev = block.height > 0;
  const hasNext = tipHeight === null || block.height < tipHeight;

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          { label: 'Blocks', href: '/blocks' },
          { label: `#${formatNumber(block.height)}` },
        ]}
        />
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Block #{formatNumber(block.height)}
          </Typography>
          {block.isSuperblock && <Chip label="superblock" color="secondary" />}
          {block.isPos ? <Chip label="PoS" /> : <Chip label="PoW" variant="outlined" />}
          <Box sx={{ flexGrow: 1 }} />
          <Stack direction="row" spacing={1}>
            <Button
              component={Link}
              href={hasPrev ? `/block/${block.height - 1}` : '#'}
              size="small"
              variant="outlined"
              disabled={!hasPrev}
              startIcon={<ChevronLeftIcon />}
              onClick={() => hasPrev && track('Block: nav', { dir: 'prev' })}
            >
              Prev
            </Button>
            {hasNext && (
              <Button
                component={Link}
                href={`/block/${block.height + 1}`}
                size="small"
                variant="outlined"
                endIcon={<ChevronRightIcon />}
                onClick={() => track('Block: nav', { dir: 'next' })}
              >
                Next
              </Button>
            )}
          </Stack>
        </Stack>

        <Card variant="outlined">
          <CardContent>
            <DetailRow label="Hash" value={block.hash} mono />
            <DetailRow label="Previous" value={<Link href={`/block/${block.height - 1}`} style={{ color: 'inherit' }}><HashTrim text={block.prevHash} /></Link>} />
            <DetailRow label="Merkle root" value={<HashTrim text={block.merkleRoot} />} />
            <DetailRow label="Time" value={formatTime(block.time)} />
            <DetailRow
              label="Block version"
              value={`${block.version} · ${blockEraLabel(block.version)}`}
            />
            <DetailRow label="Difficulty" value={block.difficulty} />
            <DetailRow label="Size" value={`${formatNumber(block.size)} bytes`} />
            <DetailRow label="Transactions" value={String(block.txCount)} />
            <DetailRow label="Mint (this block)" value={`${formatGrc(block.mint)} GRC`} />
            <DetailRow label="Money supply" value={`${formatGrc(block.moneySupply)} GRC`} />
            {block.minerAddress && (
              <DetailRow label="Staker / miner" value={(
                <Link href={`/addresses/${block.minerAddress}`} style={{ color: 'inherit' }}>{block.minerAddress}</Link>
              )} mono />
            )}
            {block.stakerCpid && (
              <DetailRow label="Researcher CPID" value={(
                <Link href={`/cpids/${block.stakerCpid}`} style={{ color: 'inherit' }}>{block.stakerCpid}</Link>
              )} mono />
            )}
          </CardContent>
        </Card>

        {claim && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary">Claim</Typography>
              <DetailRow label="Organization" value={claim.organization || '—'} />
              <DetailRow label="Client" value={claim.client_version} />
              <DetailRow label="Block reward" value={`${formatGrc(claim.block_subsidy)} GRC`} />
              <DetailRow label="Research reward" value={`${formatGrc(claim.research_subsidy)} GRC`} />
              <DetailRow label="Magnitude" value={claim.magnitude.toFixed(4)} />
              {claim.is_mrc && (
                <>
                  <DetailRow
                    label="MRC fees → staker"
                    value={`${formatGrc(claim.mrc_staker_fees ?? '0')} GRC`}
                  />
                  <DetailRow
                    label="MRC fees → foundation"
                    value={`${formatGrc(claim.mrc_foundation_fees ?? '0')} GRC`}
                  />
                </>
              )}
              {claim.is_mrc && <Chip label="MRC" size="small" color="secondary" sx={{ mt: 1 }} />}
            </CardContent>
          </Card>
        )}

        {mrcs.length > 0 && (
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
              Research recipients (MRC): {mrcs.length}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>CPID</TableCell>
                  <TableCell align="right">Magnitude</TableCell>
                  <TableCell align="right">Research reward (GRC)</TableCell>
                  <TableCell>Pay-to address</TableCell>
                  <TableCell>Client</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mrcs.map((m) => (
                  <TableRow key={m.cpid} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      <Link href={`/cpids/${m.cpid}`} style={{ color: 'inherit' }}>{m.cpid}</Link>
                    </TableCell>
                    <TableCell align="right">{m.magnitude.toFixed(2)}</TableCell>
                    <TableCell align="right">{`${formatGrc(m.researchSubsidy)} GRC`}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {m.payToAddress
                        ? <Link href={`/addresses/${m.payToAddress}`} style={{ color: 'inherit' }}>{m.payToAddress}</Link>
                        : '—'}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>{m.clientVersion || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}

        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">
            Transactions in this block
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tx ID</TableCell>
                <TableCell align="right">Total out (GRC)</TableCell>
                <TableCell align="right">Fee (GRC)</TableCell>
                <TableCell>Type</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {transactions.map((t) => (
                <TableRow key={t.txId} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link
                      href={`/transactions/${t.txId}`}
                      style={{ color: 'inherit' }}
                      onClick={() => track('Tx: open', { from: 'block' })}
                    >
                      <HashTrim text={t.txId} />
                    </Link>
                  </TableCell>
                  <TableCell align="right">{`${formatGrc(t.totalOut)} GRC`}</TableCell>
                  <TableCell align="right">{`${formatGrc(t.fee)} GRC`}</TableCell>
                  <TableCell>
                    <TxTypeChip isCoinbase={t.isCoinbase} isCoinstake={t.isCoinstake} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Layout>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ display: 'flex', py: 0.5, gap: 2 }}>
      <Typography variant="body2" sx={{ width: 180, color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? 12 : 14, wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Shared SSR fetch helper — both /block/[height] and the legacy redirect
 * dispatcher in /blocks/[year] use this. Returns null when the height
 * is unknown (or RPC fails) so callers can hand off to Next's notFound.
 */
export async function fetchBlockDetailProps(height: string): Promise<BlockDetailProps | null> {
  try {
    const r = await api.get(`/blocks/${height}`);
    const attrs = r.data?.data?.attributes as Block | undefined;
    if (!attrs) return null;
    const c = r.data?.claim;
    return {
      initialBlock: attrs,
      initialTransactions: r.data?.transactions ?? [],
      initialClaim: c ? {
        cpid: c.cpid,
        organization: c.organization,
        client_version: c.client_version,
        block_subsidy: c.block_subsidy?.toString() ?? '0',
        research_subsidy: c.research_subsidy?.toString() ?? '0',
        magnitude: c.magnitude ?? 0,
        is_mrc: !!c.is_mrc,
        mrc_foundation_fees: c.mrc_foundation_fees?.toString() ?? '0',
        mrc_staker_fees: c.mrc_staker_fees?.toString() ?? '0',
      } : null,
      initialMrcs: r.data?.mrcs ?? [],
      initialTipHeight: typeof r.data?.tipHeight === 'number' ? r.data.tipHeight : null,
    };
  } catch {
    return null;
  }
}
