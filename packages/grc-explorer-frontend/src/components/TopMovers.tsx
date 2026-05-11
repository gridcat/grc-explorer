import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useCpidNames } from '../hooks/useCpidNames';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { CpidLabel } from './CpidLabel';

interface Entry {
  cpid: string;
  rank: number;
  magnitude: number;
  rankThen: number | null;
  rankDelta: number | null;
  isNew: boolean;
}

const COMPARE_DAYS_AGO = 30;
const TOP = 5;

/**
 * Highlights the most-changed CPIDs over the last 30 days. Climbers
 * with positive rankDelta, fallers with negative rankDelta, plus a row
 * of NEW entrants. Reads `/cpids/leaderboard?compare_at=` — the same
 * endpoint that powers the rank-delta column on the main magnitude
 * leaderboard, just sliced differently.
 */
export function TopMovers() {
  const tm = useTimeMachine();
  const [entries, setEntries] = useState<Entry[]>([]);
  const cancelledRef = useRef(false);

  // We pass `compare_days` rather than computing `compare_at` from
  // wall-clock `Date.now()`. During backfill the indexer's chain-time
  // is years behind real time, and a wall-clock-derived `compare_at`
  // would land beyond the latest indexed superblock — collapsing to
  // the same anchor as `current` and yielding zero rank-deltas. The
  // backend resolves `compare_days` against the current superblock's
  // chain-time, which is correct in both backfill and live.
  const refresh = useCallback(() => {
    api.get('/cpids/leaderboard', {
      params: {
        limit: 100,
        compare_days: COMPARE_DAYS_AGO,
        ...atParam(tm.at),
      },
    }).then((r) => {
      if (cancelledRef.current) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: Entry }>;
      setEntries(data.map((d) => d.attributes));
    }).catch(() => { /* ignore */ });
  }, [tm.at]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  // SSE-driven update: a new block is the cheapest signal that
  // ranks may have shifted (each superblock = one rank refresh
  // worth doing). Debounced because backfill bursts fire many
  // block.new events per second; slow safety-net poll catches a
  // dropped SSE.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      refresh();
    }, 60_000);
  });
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (tm.isReplay) return undefined;
    const STALE_MS = 5 * 60 * 1000;
    const id = setInterval(refresh, STALE_MS);
    return () => clearInterval(id);
  }, [refresh, tm.isReplay]);

  const climbers = entries
    .filter((e) => e.rankDelta !== null && e.rankDelta > 0)
    .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))
    .slice(0, TOP);
  const fallers = entries
    .filter((e) => e.rankDelta !== null && e.rankDelta < 0)
    .sort((a, b) => (a.rankDelta ?? 0) - (b.rankDelta ?? 0))
    .slice(0, TOP);
  const newcomers = entries.filter((e) => e.isNew).slice(0, TOP);

  const empty = entries.length === 0
    || (climbers.length === 0 && fallers.length === 0 && newcomers.length === 0);

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle2" color="text.secondary">
          Top movers · last {COMPARE_DAYS_AGO} days
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Biggest rank changes among the top researchers.
        </Typography>

        {empty ? (
          <Box sx={{
            mt: 2, p: 2, borderRadius: 1, color: 'text.disabled', textAlign: 'center', border: 1, borderStyle: 'dashed', borderColor: 'divider',
          }}
          >
            <Typography variant="body2">
              Waiting for {COMPARE_DAYS_AGO} days of superblock history.
            </Typography>
          </Box>
        ) : (
          <Sections climbers={climbers} fallers={fallers} newcomers={newcomers} />
        )}
      </CardContent>
    </Card>
  );
}

// Wrapper that does ONE batched name lookup for every CPID across
// climbers + fallers + newcomers. Doing the lookup per <Section>
// would split the same handful of CPIDs into three round trips
// (although the in-memory cache would coalesce after the first
// render, the initial paint still costs three fetches).
function Sections({
  climbers, fallers, newcomers,
}: {
  climbers: Entry[]; fallers: Entry[]; newcomers: Entry[];
}) {
  const allCpids = [...climbers, ...fallers, ...newcomers].map((e) => e.cpid);
  const names = useCpidNames(allCpids);
  return (
    <Stack spacing={2} sx={{ mt: 1.5 }}>
      <Section title="Climbers" entries={climbers} kind="climber" names={names} />
      <Section title="Fallers" entries={fallers} kind="faller" names={names} />
      <Section title="New in top 100" entries={newcomers} kind="new" names={names} />
    </Stack>
  );
}

function Section({
  title, entries, kind, names,
}: {
  title: string;
  entries: Entry[];
  kind: 'climber' | 'faller' | 'new';
  names: Map<string, string>;
}) {
  if (entries.length === 0) return null;
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 10 }}>
        {title}
      </Typography>
      {/* Each row is a motion element keyed on cpid so framer-motion can
          fade entrants in, fade exits out, and slide rows that swap rank
          via the `layout` prop. AnimatePresence lets the exit animation
          actually run before the row unmounts. */}
      <Box sx={{ mt: 0.5 }}>
        <AnimatePresence initial={false}>
          {entries.map((e) => (
            <motion.div
              key={e.cpid}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
            >
              <Stack
                direction="row"
                spacing={1.5}
                sx={{ py: 0.75, alignItems: 'center' }}
              >
                <Box sx={{ width: 64 }}>
                  <DeltaBadge entry={e} kind={kind} />
                </Box>
                <Link
                  href={`/cpids/${e.cpid}`}
                  style={{ textDecoration: 'none', color: 'inherit', flex: 1, minWidth: 0 }}
                >
                  <CpidLabel cpid={e.cpid} name={names.get(e.cpid)} />
                </Link>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ width: 64, textAlign: 'right' }}
                >
                  {`#${e.rank}`}
                </Typography>
              </Stack>
            </motion.div>
          ))}
        </AnimatePresence>
      </Box>
    </Box>
  );
}

function DeltaBadge({
  entry,
  kind,
}: {
  entry: Entry;
  kind: 'climber' | 'faller' | 'new';
}) {
  if (kind === 'new') {
    return (
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700, fontSize: 10, color: 'success.main', textTransform: 'uppercase', letterSpacing: 0.5,
        }}
      >
        NEW
      </Typography>
    );
  }
  const delta = entry.rankDelta ?? 0;
  return (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 700,
        fontSize: 12,
        color: kind === 'climber' ? 'success.main' : 'error.main',
      }}
    >
      {`${kind === 'climber' ? '↑' : '↓'}${Math.abs(delta)}`}
    </Typography>
  );
}
