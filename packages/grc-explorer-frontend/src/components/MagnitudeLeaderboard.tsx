import {
  Box, Button, Card, CardContent, Stack, Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTheme } from '@mui/material/styles';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useCpidNames } from '../hooks/useCpidNames';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { CpidLabel } from './CpidLabel';
import { SeeMoreButton } from './SeeMoreButton';

export interface Entry {
  cpid: string;
  // Server-resolved BOINC name (API enrichment); seeds useCpidNames so
  // the first paint shows names without a /cpids/names round trip.
  displayName?: string | null;
  magnitude: number;
  history: Array<{ height: number; magnitude: number }>;
}

export interface LeaderboardEntry {
  cpid: string;
  displayName?: string | null;
  rank: number;
  magnitude: number;
  rankThen: number | null;
  rankDelta: number | null;
  isNew: boolean;
}

const COMPARE_DAYS_AGO = 30;
const TOP_N = 15;

export function MagnitudeLeaderboard({
  initialRows = [],
  initialDeltas = [],
  initialNames,
}: {
  initialRows?: Entry[];
  initialDeltas?: LeaderboardEntry[];
  initialNames?: Record<string, string>;
} = {}) {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [rows, setRows] = useState<Entry[]>(initialRows);
  const [deltas, setDeltas] = useState<Map<string, LeaderboardEntry>>(() => {
    const m = new Map<string, LeaderboardEntry>();
    initialDeltas.forEach((d) => m.set(d.cpid, d));
    return m;
  });

  const cancelledRef = useRef(false);
  // Skip the first fetch when SSR has already hydrated state. Live
  // refresh via SSE / safety poll keeps things current on top.
  const initialSeed = initialRows.length > 0;
  const skipFirstFetchRef = useRef(initialSeed);
  const refresh = useCallback(() => {
    api.get('/metrics/leaderboard/magnitude', {
      params: { limit: TOP_N, ...atParam(tm.at) },
    }).then((r) => {
      if (cancelledRef.current) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: Entry }>;
      setRows(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });

    // Rank-delta lookup. Uses the `compare_days` shorthand so the
    // backend resolves the comparison anchor against the current
    // superblock's chain-time — wall-clock-now would land beyond the
    // latest indexed superblock during backfill and the deltas would
    // collapse to zero across the board.
    api.get('/cpids/leaderboard', {
      params: { limit: TOP_N, compare_days: COMPARE_DAYS_AGO, ...atParam(tm.at) },
    }).then((r) => {
      if (cancelledRef.current) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: LeaderboardEntry }>;
      const map = new Map<string, LeaderboardEntry>();
      data.forEach((d) => map.set(d.attributes.cpid, d.attributes));
      setDeltas(map);
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => {
    cancelledRef.current = false;
    if (skipFirstFetchRef.current) {
      skipFirstFetchRef.current = false;
    } else {
      refresh();
    }
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // SSE-driven refresh on `superblock.new` — the leaderboard's
  // underlying data (latest superblock + 14-superblock window) only
  // moves when a superblock lands, so listening to per-block events
  // would just trigger ~1440 no-op refetches per real change.
  useSSE(['superblock.new'], () => {
    if (tm.isReplay) return;
    refresh();
  });

  // Slow safety-net poll. SSE auto-reconnects but doesn't replay, and
  // useSSE drops events while the tab is backgrounded — so a hidden
  // tab through a superblock + a silent disconnect would otherwise sit
  // on stale data until the user navigates. 1 h bounds that staleness
  // while staying well under the ~24 h superblock cadence.
  useEffect(() => {
    if (tm.isReplay) return undefined;
    const id = setInterval(refresh, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const cpidList = useMemo(() => rows.map((r) => r.cpid), [rows]);
  const names = useCpidNames(cpidList, initialNames);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Top researchers by magnitude
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {`Last 14 superblocks · rank vs ${COMPARE_DAYS_AGO} days ago`}
            </Typography>
          </Box>
          <SeeMoreButton href="/researchers/history" label="See history" />
        </Stack>
        {/* Each row is keyed on cpid so framer-motion can fade entrants
            in, fade exits out, and physically slide rows when their
            rank shifts (the `layout` prop animates DOM-position
            changes). The sparkline path itself morphs smoothly via a
            <motion.path> inside <Sparkline>. */}
        <Box sx={{ mt: 1 }}>
          <AnimatePresence initial={false}>
            {rows.map((r, i) => {
              const d = deltas.get(r.cpid);
              return (
                <motion.div
                  key={r.cpid}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.35, ease: 'easeOut' }}
                  style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
                >
                  <Stack
                    direction="row"
                    spacing={2}
                    sx={{ py: 1, alignItems: 'center' }}
                  >
                    <Typography variant="body2" sx={{ width: 24, color: 'text.secondary' }}>
                      {i + 1}
                    </Typography>
                    <Box sx={{ width: 56 }}>
                      <RankDelta entry={d} />
                    </Box>
                    <Link href={`/cpids/${r.cpid}`} style={{ textDecoration: 'none', color: 'inherit', flex: 1, minWidth: 0 }}>
                      <CpidLabel cpid={r.cpid} name={names.get(r.cpid)} />
                    </Link>
                    <Box sx={{ flex: 1, minWidth: 80 }}>
                      <Sparkline points={r.history} stroke={theme.palette.primary.main} />
                    </Box>
                    <Typography variant="body2" sx={{ width: 80, textAlign: 'right', fontWeight: 600 }}>
                      {r.magnitude.toFixed(2)}
                    </Typography>
                  </Stack>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {rows.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              Waiting for the first superblock to be indexed…
            </Typography>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

/**
 * Compact rank-delta chip. Three states:
 *   - new: cpid wasn't in the prior leaderboard at all.
 *   - up/down: rank shifted by N positions (positive = climbed).
 *   - flat: rank unchanged.
 * Renders nothing while the comparison data is still loading so the
 * row layout doesn't shift after the second API call resolves.
 */
function RankDelta({ entry }: { entry: { isNew: boolean; rankDelta: number | null } | undefined }) {
  if (!entry) return null;
  if (entry.isNew) {
    return (
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          fontSize: 10,
          color: 'success.main',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        NEW
      </Typography>
    );
  }
  const delta = entry.rankDelta ?? 0;
  if (delta === 0) {
    return (
      <Typography variant="caption" sx={{ fontSize: 11, color: 'text.disabled' }}>—</Typography>
    );
  }
  const up = delta > 0;
  return (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 600,
        fontSize: 11,
        color: up ? 'success.main' : 'error.main',
      }}
    >
      {`${up ? '↑' : '↓'}${Math.abs(delta)}`}
    </Typography>
  );
}

/**
 * Inline-SVG sparkline. Replaces a recharts <ResponsiveContainer><LineChart/></ResponsiveContainer>,
 * which on this page got mounted ~20 times (once per row). Each one
 * brings a ResizeObserver, an internal layout pass and a 60-prop
 * component tree — enough to peg the main thread on initial render.
 * A two-line SVG path is essentially free.
 */
function Sparkline({
  points,
  stroke,
  width = 100,
  height = 28,
}: {
  points: Array<{ height: number; magnitude: number }>;
  stroke: string;
  width?: number;
  height?: number;
}) {
  if (!points || points.length === 0) {
    return <Box sx={{ height, opacity: 0.3, fontSize: 10 }}>—</Box>;
  }
  // Single-point history (CPID has only one superblock appearance —
  // common on a freshly-backfilled testnet) gets a centered dot rather
  // than the "—" placeholder, so the row visually distinguishes "we
  // know this researcher's magnitude, just no trend yet" from "no data".
  if (points.length === 1) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <circle cx={width / 2} cy={height / 2} r={2} fill={stroke} />
      </svg>
    );
  }
  // Reverse so oldest is on the left (history arrives newest-first).
  const ordered = [...points].reverse();
  let min = ordered[0].magnitude;
  let max = ordered[0].magnitude;
  for (const p of ordered) {
    if (p.magnitude < min) min = p.magnitude;
    if (p.magnitude > max) max = p.magnitude;
  }
  const span = max - min || 1;
  const stepX = width / Math.max(1, ordered.length - 1);
  let path = '';
  for (let i = 0; i < ordered.length; i += 1) {
    const x = i * stepX;
    const y = height - ((ordered[i].magnitude - min) / span) * height;
    path += `${i === 0 ? 'M' : ' L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  // motion.path with `animate={{ d: path }}` morphs the stroke
  // continuously when the underlying data changes — a new superblock
  // makes the line glide forward instead of snapping. framer-motion
  // interpolates per-coordinate when the `M`/`L` command sequence is
  // structurally the same length, which holds here (always SLOTS
  // consecutive `L` segments).
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <motion.path
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={false}
        animate={{ d: path }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
    </svg>
  );
}
