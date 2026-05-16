import {
  Box, Card, CardContent, Stack, Typography,
} from '@mui/material';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { useCpidNames } from '../hooks/useCpidNames';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import { CpidLabel } from './CpidLabel';
import { EmptyState } from './EmptyState';

export interface TopMoversEntry {
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
export function TopMovers({
  initialEntries = [],
  initialNames,
}: {
  initialEntries?: TopMoversEntry[];
  initialNames?: Record<string, string>;
} = {}) {
  const tm = useTimeMachine();
  const [entries, setEntries] = useState<TopMoversEntry[]>(initialEntries);
  const cancelledRef = useRef(false);
  const skipFirstFetchRef = useRef(initialEntries.length > 0);

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
      const data = (r.data?.data ?? []) as Array<{ attributes: TopMoversEntry }>;
      setEntries(data.map((d) => d.attributes));
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

  // SSE-driven refresh on `superblock.new` — rank deltas are anchored
  // to the latest superblock at-or-before the comparison time, so the
  // response only changes when a new superblock is indexed. Listening
  // to per-block events would just trigger ~1440 no-op refetches per
  // real change.
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

  const { climbers, fallers, newcomers } = useMemo(() => ({
    climbers: entries
      .filter((e) => e.rankDelta !== null && e.rankDelta > 0)
      .sort((a, b) => (b.rankDelta ?? 0) - (a.rankDelta ?? 0))
      .slice(0, TOP),
    fallers: entries
      .filter((e) => e.rankDelta !== null && e.rankDelta < 0)
      .sort((a, b) => (a.rankDelta ?? 0) - (b.rankDelta ?? 0))
      .slice(0, TOP),
    newcomers: entries.filter((e) => e.isNew).slice(0, TOP),
  }), [entries]);

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
          <EmptyState>
            <Typography variant="body2">
              Waiting for {COMPARE_DAYS_AGO} days of superblock history.
            </Typography>
          </EmptyState>
        ) : (
          <Sections climbers={climbers} fallers={fallers} newcomers={newcomers} initialNames={initialNames} />
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
  climbers, fallers, newcomers, initialNames,
}: {
  climbers: TopMoversEntry[]; fallers: TopMoversEntry[]; newcomers: TopMoversEntry[];
  initialNames?: Record<string, string>;
}) {
  const allCpids = useMemo(
    () => [...climbers, ...fallers, ...newcomers].map((e) => e.cpid),
    [climbers, fallers, newcomers],
  );
  const names = useCpidNames(allCpids, initialNames);
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
  entries: TopMoversEntry[];
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
  entry: TopMoversEntry;
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
