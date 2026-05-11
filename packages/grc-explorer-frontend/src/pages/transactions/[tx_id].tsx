import {
  Accordion, AccordionDetails, AccordionSummary, Box, Button, Card, CardContent, Chip, IconButton, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { JsonTree } from '../../components/JsonTree';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatGrc, formatTime } from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs } from '../../components/Crumbs';
import { CpidLabel } from '../../components/CpidLabel';
import { useCpidNames } from '../../hooks/useCpidNames';
import { formatNumber, shortHash } from '../../lib/format';

interface Tx {
  txId: string;
  blockHeight: number;
  blockHash: string;
  time: number;
  size: number;
  fee: string;
  totalIn: string;
  totalOut: string;
  isCoinbase: boolean;
  isCoinstake: boolean;
}
interface Vin { vinN: number; prevTx: string; prevVout: number; address: string | null; value: string | null }
interface Vout { voutN: number; value: string; address: string | null; scriptType: string; isSpent: boolean; spentInTx: string | null }
interface RawTx { hex: string; decoded: unknown }
interface MrcInfo {
  version: number;
  cpid: string;
  clientVersion: string;
  organization: string;
  researchSubsidy: string;
  feeOffered: string;
  magnitude: number;
  magnitudeUnit: number;
  lastBlockHash: string;
  signature: string;
  payToAddress: string | null;
  firstSeen: number;
  blockHeight: number | null;
  blockTime: number | null;
}

// `pending` is set when the cascade in /transactions/:tx_id falls
// through to the mempool_txs row or RPC fallback (i.e. the tx isn't in
// our `transactions` index yet). 'mempool' = still unconfirmed;
// 'unindexed' = confirmed by the daemon but the indexer hasn't reached
// the containing block yet (common during deep backfill).
type PendingState = 'mempool' | 'unindexed' | null;

interface TxDetailProps {
  initialTx: Tx | null;
  initialVins: Vin[];
  initialVouts: Vout[];
  initialConfirmations: number;
  initialPending: PendingState;
  initialMrc: MrcInfo | null;
}

export default function TxDetail({
  initialTx, initialVins, initialVouts, initialConfirmations, initialPending, initialMrc,
}: TxDetailProps) {
  const router = useRouter();
  const { tx_id: txId } = router.query;
  const [tx, setTx] = useState<Tx | null>(initialTx);
  const [vins, setVins] = useState<Vin[]>(initialVins);
  const [vouts, setVouts] = useState<Vout[]>(initialVouts);
  const [confirmations, setConfirmations] = useState(initialConfirmations);
  const [pending, setPending] = useState<PendingState>(initialPending);
  const [mrc, setMrc] = useState<MrcInfo | null>(initialMrc);

  // Raw tx body — single fetch shared between the stamp-prefix
  // detector (📮 chip in the header) and the collapsible "Raw
  // transaction" accordion below. The /raw endpoint is Redis-cached,
  // so the wire cost is one round trip per tx-detail mount; both
  // consumers now derive from the same state instead of fetching
  // twice with separate accordion-expand and on-mount handlers.
  const [raw, setRaw] = useState<RawTx | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);

  useEffect(() => {
    if (!txId) return;
    if (tx && tx.txId === txId) return;
    api.get(`/transactions/${txId}`).then((r) => {
      setTx(r.data?.data?.attributes ?? null);
      setVins(r.data?.vins ?? []);
      setVouts(r.data?.vouts ?? []);
      setConfirmations(r.data?.confirmations ?? 0);
      setPending((r.data?.pending as PendingState | undefined) ?? null);
      setMrc((r.data?.mrc as MrcInfo | undefined) ?? null);
    }).catch(() => { /* ignore */ });
  }, [txId, tx]);

  useEffect(() => {
    if (typeof txId !== 'string' || !txId) return;
    setRaw(null);
    setRawError(null);
    setRawLoading(true);
    api.get(`/transactions/${txId}/raw`).then((r) => {
      setRaw(r.data?.data?.attributes ?? null);
    }).catch((e) => {
      setRawError(e?.response?.data?.errors?.[0]?.detail ?? 'Failed to load raw transaction');
    }).finally(() => setRawLoading(false));
  }, [txId]);

  // Stamp protocol detection: family Easter egg — surfaces a 📮 next
  // to the tx when any vout is an OP_RETURN carrying the
  // stamp.gridcoin.club `5ea1ed` prefix (memory:
  // `project_stamp_block_prefix`). `asm` is deterministically derived
  // from `hex`, so matching the hex byte sequence is the canonical
  // test — no need to also probe the asm string.
  const isStamp = useMemo(() => {
    const decoded = raw?.decoded as
      | { vout?: Array<{ scriptPubKey?: { type?: string; hex?: string } }> }
      | undefined;
    return Boolean(decoded?.vout?.some((v) => (
      v?.scriptPubKey?.type === 'nulldata'
      && /^6a[0-9a-f]{2}5ea1ed/i.test(v.scriptPubKey?.hex ?? '')
    )));
  }, [raw]);

  // Hook must run before the early-return below (rules of hooks).
  const mrcCpidList: string[] = mrc?.cpid ? [mrc.cpid] : [];
  const names = useCpidNames(mrcCpidList);

  if (!tx) return <Layout><Typography>Loading…</Typography></Layout>;

  // Confirmed txs live inside their containing block; mempool/unindexed
  // txs don't yet, so the breadcrumb branches on confirmation. The
  // chain-model framing ("a transaction is part of a block") is what
  // users expect from an explorer trail.
  const inMempool = pending !== null || !tx.blockHeight || confirmations === 0;
  const crumbItems = inMempool
    ? [
      { label: 'Mempool', href: '/mempool' },
      { label: shortHash(tx.txId, 8, 6) },
    ]
    : [
      { label: 'Blocks', href: '/blocks' },
      { label: `#${formatNumber(tx.blockHeight)}`, href: `/block/${tx.blockHeight}` },
      { label: shortHash(tx.txId, 8, 6) },
    ];

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={crumbItems} />
        <Typography variant="h5" sx={{ fontWeight: 700, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {tx.txId}
        </Typography>
        <Stack direction="row" spacing={1}>
          {tx.isCoinbase && <Chip label="coinbase" size="small" />}
          {tx.isCoinstake && <Chip label="coinstake" size="small" />}
          {mrc && <Chip label="MRC request" size="small" color="secondary" variant="outlined" />}
          {isStamp && (
            <Tooltip title="OP_RETURN 5ea1ed — protocol marker for stamp.gridcoin.club">
              <Chip label="📮 stamp" size="small" variant="outlined" />
            </Tooltip>
          )}
          {pending === 'mempool' && (
            <Chip label="pending in mempool" size="small" color="warning" />
          )}
          {pending === 'unindexed' && (
            <Chip label="confirmed · indexer catching up" size="small" color="info" />
          )}
          {pending === null && (
            <Chip
              label={confirmations < 6 ? `${confirmations} confirmations · soft` : `${confirmations} confirmations`}
              size="small"
              color={confirmations >= 6 ? 'success' : 'warning'}
            />
          )}
        </Stack>

        <Card variant="outlined">
          <CardContent>
            {/* Block + block-hash rows are real-data when indexed, partial
                when 'unindexed' (we have the daemon's blockhash but not
                the height/time-from-DB), absent when 'mempool'. Render
                "—" rather than synthetic zeros so users aren't misled by
                a rendered "Block #0". */}
            {pending === null && (
              <DetailRow label="Block" value={(<Link href={`/block/${tx.blockHeight}`} style={{ color: 'inherit' }}>#{tx.blockHeight}</Link>)} />
            )}
            {pending === 'unindexed' && (
              <DetailRow label="Block" value={<span style={{ opacity: 0.6 }}>indexer not yet caught up</span>} />
            )}
            {pending === 'mempool' && (
              <DetailRow label="Block" value={<span style={{ opacity: 0.6 }}>—</span>} />
            )}
            {tx.blockHash ? (
              <DetailRow label="Block hash" value={<HashTrim text={tx.blockHash} />} mono />
            ) : (
              <DetailRow label="Block hash" value={<span style={{ opacity: 0.6 }}>—</span>} mono />
            )}
            <DetailRow label="Time" value={formatTime(tx.time)} />
            <DetailRow label="Total in" value={`${formatGrc(tx.totalIn)} GRC`} />
            <DetailRow label="Total out" value={`${formatGrc(tx.totalOut)} GRC`} />
            <DetailRow label="Fee" value={`${formatGrc(tx.fee)} GRC`} />
          </CardContent>
        </Card>

        {mrc && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                MRC request
              </Typography>
              <DetailRow label="CPID" value={(
                <Link href={`/cpids/${mrc.cpid}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <CpidLabel cpid={mrc.cpid} name={names.get(mrc.cpid)} />
                </Link>
              )} />
              {mrc.organization && <DetailRow label="Organization" value={mrc.organization} />}
              <DetailRow label="Client" value={mrc.clientVersion} />
              <DetailRow label="MRC body version" value={`v${mrc.version}`} />
              <DetailRow label="Requested payout" value={`${formatGrc(mrc.researchSubsidy)} GRC`} />
              <DetailRow label="Bid fee" value={`${formatGrc(mrc.feeOffered)} GRC`} />
              <DetailRow label="Magnitude" value={String(mrc.magnitude)} />
              <DetailRow label="First seen" value={formatTime(mrc.firstSeen)} />
              {mrc.payToAddress && (
                <DetailRow
                  label="Pay-to"
                  value={(
                    <Link href={`/addresses/${mrc.payToAddress}`} style={{ color: 'inherit' }}>
                      {mrc.payToAddress}
                    </Link>
                  )}
                  mono
                />
              )}
              {mrc.blockHeight !== null ? (
                <DetailRow
                  label="Included in block"
                  value={(
                    <Link href={`/block/${mrc.blockHeight}`} style={{ color: 'inherit' }}>
                      #{formatNumber(mrc.blockHeight)}
                    </Link>
                  )}
                />
              ) : (
                <DetailRow label="Status" value={<span style={{ opacity: 0.6 }}>pending — waiting for a staker to bundle the payout</span>} />
              )}
              <DetailRow label="Anchor block" value={<HashTrim text={mrc.lastBlockHash} />} mono />
              {mrc.signature && (
                <DetailRow
                  label="Signature"
                  value={(
                    <Box sx={{ wordBreak: 'break-all', maxHeight: 80, overflowY: 'auto', fontSize: 11 }}>
                      {mrc.signature}
                    </Box>
                  )}
                  mono
                />
              )}
            </CardContent>
          </Card>
        )}

        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Inputs</Typography>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>#</TableCell><TableCell>From</TableCell><TableCell align="right">Value</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {vins.map((v) => (
                  <TableRow key={v.vinN}>
                    <TableCell>{v.vinN}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {v.address ? (
                        <Link href={`/addresses/${v.address}`} style={{ color: 'inherit' }}><HashTrim text={v.address} head={8} tail={6} /></Link>
                      ) : (
                        <span style={{ opacity: 0.6 }}>—</span>
                      )}
                    </TableCell>
                    <TableCell align="right">{formatGrc(v.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Typography variant="subtitle2" sx={{ p: 2 }} color="text.secondary">Outputs</Typography>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>#</TableCell><TableCell>To</TableCell><TableCell align="right">Value</TableCell><TableCell>Spent</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {vouts.map((o) => (
                  <TableRow key={o.voutN}>
                    <TableCell>{o.voutN}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {o.address ? (
                        <Link href={`/addresses/${o.address}`} style={{ color: 'inherit' }}><HashTrim text={o.address} head={8} tail={6} /></Link>
                      ) : (
                        <span style={{ opacity: 0.6 }}>{o.scriptType}</span>
                      )}
                    </TableCell>
                    <TableCell align="right">{formatGrc(o.value)}</TableCell>
                    {/* Spent-state is unknown for pending/unindexed txs
                        (no tx_inputs join available). Show a neutral
                        dash instead of a misleading "unspent" chip. */}
                    <TableCell>
                      {pending !== null
                        ? <span style={{ opacity: 0.6 }}>—</span>
                        : (o.isSpent ? 'spent' : <Chip label="unspent" size="small" color="success" />)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Box>

        <RawTransactionSection raw={raw} loading={rawLoading} error={rawError} />
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
 * Raw transaction view — collapsed by default. Hex (the canonical wire
 * format) and decoded JSON are shown side by side; both have
 * copy-to-clipboard. The fetch and its loading/error state live in
 * the parent so the same response also drives the 📮 stamp detector
 * in the header.
 */
function RawTransactionSection({
  raw, loading, error,
}: {
  raw: RawTx | null;
  loading: boolean;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // JSON tree fold control. Each click bumps `treeKey` so React
  // re-mounts the tree subtree; every Collapsible's useState reads
  // the new initialOpenDepth and renders accordingly. Cheaper and
  // simpler than threading an external open-state down through every
  // recursive node.
  const [treeOpenDepth, setTreeOpenDepth] = useState(2);
  const [treeKey, setTreeKey] = useState(0);
  const setMode = (depth: number) => {
    setTreeOpenDepth(depth);
    setTreeKey((k) => k + 1);
  };

  const handleChange = (_e: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded);
  };

  const copy = (text: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  };

  return (
    <Accordion variant="outlined" expanded={expanded} onChange={handleChange}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2" color="text.secondary">Raw transaction</Typography>
      </AccordionSummary>
      <AccordionDetails>
        {loading && <Typography variant="body2" color="text.secondary">Loading…</Typography>}
        {error && <Typography variant="body2" color="error">{error}</Typography>}
        {raw && (
          <Stack spacing={3}>
            <Box>
              <Stack direction="row" sx={{ alignItems: 'center', mb: 1, justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                  Hex
                </Typography>
                <Tooltip title="Copy hex">
                  <IconButton size="small" onClick={() => copy(raw.hex)}>
                    <ContentCopyIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'background.default',
                  border: 1,
                  borderColor: 'divider',
                  // Wrap aggressively so long hex doesn't overflow horizontally.
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  m: 0,
                }}
              >
                {raw.hex}
              </Box>
            </Box>
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                  Decoded JSON
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setMode(Number.MAX_SAFE_INTEGER)}
                    sx={{ minWidth: 0, px: 1, py: 0, fontSize: 12, textTransform: 'none' }}
                  >
                    Expand all
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setMode(0)}
                    sx={{ minWidth: 0, px: 1, py: 0, fontSize: 12, textTransform: 'none' }}
                  >
                    Collapse all
                  </Button>
                  <Tooltip title="Copy JSON">
                    <IconButton size="small" onClick={() => copy(JSON.stringify(raw.decoded, null, 2))}>
                      <ContentCopyIcon fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'background.default',
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <JsonTree key={treeKey} value={raw.decoded} initialOpenDepth={treeOpenDepth} />
              </Box>
            </Box>
          </Stack>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

export const getServerSideProps: GetServerSideProps<TxDetailProps> = async (ctx) => {
  const { tx_id: txId } = ctx.params ?? {};
  if (typeof txId !== 'string') return { notFound: true };
  try {
    const r = await api.get(`/transactions/${txId}`);
    const attrs = r.data?.data?.attributes as Tx | undefined;
    if (!attrs) return { notFound: true };
    return {
      props: {
        initialTx: attrs,
        initialVins: r.data?.vins ?? [],
        initialVouts: r.data?.vouts ?? [],
        initialConfirmations: r.data?.confirmations ?? 0,
        initialPending: (r.data?.pending as PendingState | undefined) ?? null,
        initialMrc: (r.data?.mrc as MrcInfo | undefined) ?? null,
      },
    };
  } catch {
    return { notFound: true };
  }
};
