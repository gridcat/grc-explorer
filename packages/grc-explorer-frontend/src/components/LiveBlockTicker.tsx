import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useCpidNames } from '../hooks/useCpidNames';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { BlockTable, BlockRowData } from './BlockTable';

export interface BlockEntry {
  height: number;
  hash: string;
  time: number;
  tx_count: number;
  is_pos: boolean;
  is_superblock: boolean;
  is_mrc: boolean;
  value_moved: string;
  fee_total: string;
  difficulty: string;
  size: number;
  mint: string;
  miner_address?: string | null;
  staker_cpid?: string | null;
  // Server-resolved staker name from the REST seed (absent on the SSE
  // live path — useCpidNames resolves those client-side).
  staker_name?: string | null;
}

// REST `/blocks` attributes (JSON:API camelCase). The SSR seed (home
// page) and the polled fallback below both receive this shape and map
// it onto the snake_case BlockEntry the ticker stores — which mirrors
// the SSE payload, so the two update paths can't disagree on field
// names. Without this map a polled refresh wiped staker / PoS / tx-count
// to undefined and rendered every row as "investor".
export interface BlockAttrs {
  height: number;
  hash: string;
  time: number;
  txCount: number;
  isPos: boolean;
  isSuperblock: boolean;
  isMrc?: boolean;
  valueMoved?: string;
  feeTotal?: string;
  difficulty?: string;
  size?: number;
  mint?: string;
  minerAddress?: string | null;
  stakerCpid?: string | null;
  stakerName?: string | null;
}

export function mapBlockAttrsToEntry(a: BlockAttrs): BlockEntry {
  return {
    height: a.height,
    hash: a.hash,
    time: a.time,
    tx_count: a.txCount,
    is_pos: a.isPos,
    is_superblock: a.isSuperblock,
    is_mrc: Boolean(a.isMrc),
    value_moved: a.valueMoved ?? '0',
    fee_total: a.feeTotal ?? '0',
    difficulty: a.difficulty ?? '0',
    size: a.size ?? 0,
    mint: a.mint ?? '0',
    miner_address: a.minerAddress ?? null,
    staker_cpid: a.stakerCpid ?? null,
    staker_name: a.stakerName ?? null,
  };
}

const MAX_VISIBLE = 12;

export function LiveBlockTicker({
  initialBlocks = [],
  initialNames,
}: {
  initialBlocks?: BlockEntry[];
  initialNames?: Record<string, string>;
} = {}) {
  const tm = useTimeMachine();
  const [blocks, setBlocks] = useState<BlockEntry[]>(initialBlocks);
  const skipFirstFetchRef = useRef(initialBlocks.length > 0);

  // SSE-aware fallback fetch. SSE `block.new` is the primary update
  // channel; the polled fetch is a safety net for when the EventSource
  // stalls, the user returns from a hidden tab, or the indexer is in
  // backfill catch-up. We track the last SSE arrival in `lastEventAtRef`
  // and only re-fetch if nothing has landed in `STALE_MS`. While SSE is
  // healthy the network is idle.
  const lastEventAtRef = useRef<number>(Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => api.get('/blocks', {
      params: { 'page[size]': MAX_VISIBLE, ...atParam(tm.at) },
    }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: BlockAttrs }>;
      const next: BlockEntry[] = data.map((d) => mapBlockAttrsToEntry(d.attributes));
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
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      fetchOnce();
    }
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

  // Resolve display names for every PoS staker currently in view.
  // The hook caches across renders so SSE-driven block arrivals only
  // fetch the *new* CPID, not the whole window each time.
  const stakerCpids = blocks
    .map((b) => b.staker_cpid)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  const names = useCpidNames(stakerCpids, initialNames);

  // Map the snake_case SSE/seed shape onto the shared BlockTable row.
  // Recomputes when names resolve so late-arriving CPIDs show up.
  const rows: BlockRowData[] = useMemo(() => blocks.map((b) => ({
    height: b.height,
    hash: b.hash,
    time: b.time,
    txCount: b.tx_count,
    isPos: b.is_pos,
    isSuperblock: b.is_superblock,
    isMrc: b.is_mrc,
    valueMoved: b.value_moved,
    feeTotal: b.fee_total,
    difficulty: b.difficulty,
    size: b.size,
    reward: b.mint,
    stakerCpid: b.staker_cpid ?? null,
    stakerName: b.staker_cpid ? names.get(b.staker_cpid) ?? null : null,
  })), [blocks, names]);

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
          <BlockTable
            blocks={rows}
            liveAge
            minRows={MAX_VISIBLE}
            emptyMessage="Waiting for the indexer to catch up to chain tip…"
          />
        </Box>
      </CardContent>
    </Card>
  );
}
