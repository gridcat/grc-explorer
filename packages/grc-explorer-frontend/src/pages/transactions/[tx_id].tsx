import {
  Accordion, AccordionDetails, AccordionSummary, Box, Button, Card, CardContent, Chip, IconButton, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { JsonTree } from '../../components/JsonTree';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatGrc, formatTime } from '../../lib/format';
import { HashTrim } from '../../components/HashTrim';
import { Crumbs } from '../../components/Crumbs';
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
}

export default function TxDetail({
  initialTx, initialVins, initialVouts, initialConfirmations, initialPending,
}: TxDetailProps) {
  const router = useRouter();
  const { tx_id: txId } = router.query;
  const [tx, setTx] = useState<Tx | null>(initialTx);
  const [vins, setVins] = useState<Vin[]>(initialVins);
  const [vouts, setVouts] = useState<Vout[]>(initialVouts);
  const [confirmations, setConfirmations] = useState(initialConfirmations);
  const [pending, setPending] = useState<PendingState>(initialPending);

  useEffect(() => {
    if (!txId) return;
    if (tx && tx.txId === txId) return;
    api.get(`/transactions/${txId}`).then((r) => {
      setTx(r.data?.data?.attributes ?? null);
      setVins(r.data?.vins ?? []);
      setVouts(r.data?.vouts ?? []);
      setConfirmations(r.data?.confirmations ?? 0);
      setPending((r.data?.pending as PendingState | undefined) ?? null);
    }).catch(() => { /* ignore */ });
  }, [txId, tx]);

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

        <RawTransactionSection txId={tx.txId} />
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
 * Raw transaction view — collapsed by default. Fetches lazily on first
 * expand so we don't burn an RPC call against the wallet daemon for
 * every visitor of every tx page. Hex (the canonical wire format) and
 * decoded JSON are shown side by side; both have copy-to-clipboard.
 */
function RawTransactionSection({ txId }: { txId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState<RawTx | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (isExpanded && !raw && !loading) {
      setLoading(true);
      setError(null);
      api.get(`/transactions/${txId}/raw`).then((r) => {
        setRaw(r.data?.data?.attributes ?? null);
      }).catch((e) => {
        setError(e?.response?.data?.errors?.[0]?.detail ?? 'Failed to load raw transaction');
      }).finally(() => setLoading(false));
    }
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
      },
    };
  } catch {
    return { notFound: true };
  }
};
