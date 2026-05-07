import {
  Box, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { timeAgo } from '../lib/format';
import { HashTrim } from './HashTrim';

interface BlockEntry {
  height: number;
  hash: string;
  time: number;
  tx_count: number;
  is_pos: boolean;
  is_superblock: boolean;
  miner_address?: string | null;
  staker_cpid?: string | null;
}

const MAX_VISIBLE = 12;

// Per-row interval (rather than ticking the parent) keeps the rest of
// the table from reconciling every second. Storing the formatted string
// in state means React bails out when timeAgo's output is unchanged —
// most rows are in minute-granularity, so 29/30 ticks are no-ops.
// Pauses while the tab is hidden.
function AgeCell({ time }: { time: number }) {
  const [display, setDisplay] = useState(() => timeAgo(time));
  useEffect(() => {
    setDisplay(timeAgo(time));
    if (typeof document === 'undefined') return undefined;
    let id: ReturnType<typeof setInterval> | null = null;
    const refresh = () => setDisplay(timeAgo(time));
    const start = () => { if (id === null) id = setInterval(refresh, 1000); };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    if (!document.hidden) start();
    const onVis = () => {
      if (document.hidden) stop();
      else { refresh(); start(); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [time]);
  return <>{display}</>;
}

export function LiveBlockTicker() {
  const router = useRouter();
  const tm = useTimeMachine();
  const [blocks, setBlocks] = useState<BlockEntry[]>([]);

  // SSE-aware fallback fetch. SSE `block.new` is the primary update
  // channel; the polled fetch is a safety net for when the EventSource
  // stalls, the user returns from a hidden tab, or the indexer is in
  // backfill catch-up. We track the last SSE arrival in `lastEventAtRef`
  // and only re-fetch if nothing has landed in `STALE_MS`. While SSE is
  // healthy the network is idle.
  const lastEventAtRef = useRef<number>(Date.now());
  useEffect(() => {
    let cancelled = false;
    // The REST presenter emits camelCase attributes (txCount, stakerCpid,
    // isPos, …) — JSON:API convention. Our local BlockEntry happens to
    // mirror the SSE payload, which the indexer emits in snake_case
    // (block_writer.ts publishes `tx_count` / `staker_cpid` / etc. so
    // SSE consumers see exactly the on-chain field names). Map between
    // the two here; without this, every polled refresh wiped staker /
    // PoS / tx-count fields to undefined and rendered every row as
    // "investor" — the bug that made the table look like it grew or
    // lost data right after the 30 s poll fired.
    interface BlockApiAttrs {
      height: number;
      hash: string;
      time: number;
      txCount: number;
      isPos: boolean;
      isSuperblock: boolean;
      minerAddress?: string | null;
      stakerCpid?: string | null;
    }
    const fetchOnce = () => api.get('/blocks', {
      params: { 'page[size]': MAX_VISIBLE, ...atParam(tm.at) },
    }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: BlockApiAttrs }>;
      const next: BlockEntry[] = data.map((d) => ({
        height: d.attributes.height,
        hash: d.attributes.hash,
        time: d.attributes.time,
        tx_count: d.attributes.txCount,
        is_pos: d.attributes.isPos,
        is_superblock: d.attributes.isSuperblock,
        miner_address: d.attributes.minerAddress ?? null,
        staker_cpid: d.attributes.stakerCpid ?? null,
      }));
      setBlocks((prev) => {
        // Merge instead of replace. Replacing dropped any SSE-delivered
        // blocks that landed *after* this fetch was issued but *before*
        // it resolved — a real race during backfill where SSE arrives
        // every block. Dedup by hash, descending by height, slice to
        // MAX_VISIBLE — exactly the same shape as the SSE handler so
        // the two paths can't visibly disagree.
        const seen = new Set<string>();
        const merged: BlockEntry[] = [];
        for (const b of [...next, ...prev]) {
          if (seen.has(b.hash)) continue;
          seen.add(b.hash);
          merged.push(b);
        }
        merged.sort((x, y) => y.height - x.height);
        const sliced = merged.slice(0, MAX_VISIBLE);
        // Skip the state update entirely when nothing actually changed,
        // so a no-op poll doesn't trigger a re-render.
        if (
          sliced.length === prev.length
          && sliced.every((b, i) => b.hash === prev[i].hash)
        ) {
          return prev;
        }
        return sliced;
      });
    }).catch(() => { /* ignore */ });
    fetchOnce();
    lastEventAtRef.current = Date.now();
    if (tm.isReplay) return () => { cancelled = true; };
    // Re-fetch only when SSE has been silent for STALE_MS. The check
    // itself reschedules unconditionally so a stalled EventSource is
    // detected within the next window without needing visibility events.
    const STALE_MS = 3 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (cancelled) return;
      if (Date.now() - lastEventAtRef.current >= STALE_MS) {
        fetchOnce();
        lastEventAtRef.current = Date.now();
      }
      timer = setTimeout(check, STALE_MS);
    };
    timer = setTimeout(check, STALE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tm.at, tm.isReplay]);

  // Coalesce bursts. TipFollower can apply 20+ blocks in a single tick
  // when the indexer is catching up, firing as many `block.new` events
  // back-to-back. Without this the table re-renders 20 times in a few
  // ms and the page noticeably stutters. We accumulate incoming blocks
  // in a ref and flush once per RAF (≈16ms) — bursts collapse into one
  // render that already has the final ordering.
  const queueRef = useRef<BlockEntry[]>([]);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (rafRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(rafRef.current);
    }
    queueRef.current = [];
  }, []);
  useSSE(['block.new'], (_topic, payload) => {
    if (tm.isReplay) return; // replayed state must not be polluted by live events
    lastEventAtRef.current = Date.now();
    queueRef.current.push(payload as BlockEntry);
    if (rafRef.current !== null) return;
    const flush = () => {
      rafRef.current = null;
      if (!mountedRef.current) return;
      const incoming = queueRef.current.splice(0);
      if (incoming.length === 0) return;
      setBlocks((prev) => {
        const seen = new Set<string>();
        const merged: BlockEntry[] = [];
        for (const b of [...incoming, ...prev]) {
          if (seen.has(b.hash)) continue;
          seen.add(b.hash);
          merged.push(b);
        }
        merged.sort((x, y) => y.height - x.height);
        return merged.slice(0, MAX_VISIBLE);
      });
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      rafRef.current = window.requestAnimationFrame(flush);
    } else {
      const handle = setTimeout(flush, 16);
      rafRef.current = handle as unknown as number;
    }
  });

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 0, ':last-child': { pb: 0 } }}>
        <Box sx={{ px: 2.5, pt: 2, pb: 1.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: 'success.main',
                animation: 'pulse 2s ease-in-out infinite',
                '@keyframes pulse': {
                  '0%': { opacity: 1 },
                  '50%': { opacity: 0.3 },
                  '100%': { opacity: 1 },
                },
              }}
            />
            <Typography variant="subtitle2" color="text.secondary" sx={{ letterSpacing: 0.6 }}>
              LIVE · recent blocks
            </Typography>
          </Stack>
        </Box>
        <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 720 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 110 }}>Height</TableCell>
              <TableCell>Hash</TableCell>
              <TableCell sx={{ width: 110 }}>Age</TableCell>
              <TableCell align="right" sx={{ width: 70 }}>Txs</TableCell>
              <TableCell sx={{ width: 130 }}>Type</TableCell>
              <TableCell sx={{ width: 140 }}>Staker</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {blocks.map((b) => (
              <TableRow
                key={b.hash}
                hover
                sx={{
                  cursor: 'pointer',
                  // Superblock rows pop out: brand-coloured left border +
                  // stronger tint. Clicks go to the dedicated superblock
                  // page (with magnitudes / projects / verified beacons)
                  // instead of the generic block detail.
                  ...(b.is_superblock && {
                    backgroundColor: (theme) => `${theme.palette.secondary.main}26`,
                    borderLeft: 4,
                    borderLeftColor: 'secondary.main',
                  }),
                }}
                onClick={() => {
                  if (b.is_superblock) router.push(`/superblocks/${b.height}`);
                  else router.push(`/block/${b.height}`);
                }}
                onMouseEnter={() => {
                  if (b.is_superblock) router.prefetch(`/superblocks/${b.height}`);
                  else router.prefetch(`/block/${b.height}`);
                }}
              >
                <TableCell sx={{ fontWeight: 600 }}>
                  <Link
                    href={b.is_superblock ? `/superblocks/${b.height}` : `/block/${b.height}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    #{b.height.toLocaleString()}
                  </Link>
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>
                  <HashTrim text={b.hash} head={12} tail={6} />
                </TableCell>
                <TableCell sx={{ color: 'text.secondary' }}><AgeCell time={b.time} /></TableCell>
                <TableCell align="right">{b.tx_count}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5}>
                    {b.is_superblock && <Chip label="SB" size="small" color="secondary" />}
                    {b.is_pos
                      ? <Chip label="PoS" size="small" variant="outlined" />
                      : <Chip label="PoW" size="small" variant="outlined" />}
                  </Stack>
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {b.staker_cpid ? (
                    <Link
                      href={`/cpids/${b.staker_cpid}`}
                      style={{ color: 'inherit', textDecoration: 'none', fontFamily: 'monospace' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {b.staker_cpid}
                    </Link>
                  ) : (
                    <Box sx={{ color: 'text.disabled', fontStyle: 'italic' }}>investor</Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {/* Pad the row count to MAX_VISIBLE so the card is always
                12 rows tall. Without this the table grows from 1 row
                (placeholder) to 12 rows when the API resolves, plus
                shrinks if the indexer briefly has fewer blocks than
                the visible window — both reflow the rest of the page,
                which is the "scroll drift" symptom.
                The first placeholder row carries the waiting message
                if there's no data yet; the rest are blank rows of the
                same size as a real row. */}
            {Array.from({ length: Math.max(0, MAX_VISIBLE - blocks.length) }).map((_, i) => (
              <TableRow key={`pad-${i}`} sx={{ '& td': { borderColor: 'transparent' } }}>
                <TableCell
                  colSpan={6}
                  sx={{
                    textAlign: 'center',
                    color: 'text.secondary',
                    height: 41, // matches a real small-Table row height
                    py: 0,
                  }}
                >
                  {i === 0 && blocks.length === 0
                    ? 'Waiting for the indexer to catch up to chain tip…'
                    : ' '}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </Box>
      </CardContent>
    </Card>
  );
}
