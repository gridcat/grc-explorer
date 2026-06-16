import {
  Box, Chip, Paper, Stack, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSSE } from '../../hooks/useSSE';
import { useCpidNames } from '../../hooks/useCpidNames';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { BlockTable, BlockRowData } from '../../components/BlockTable';
import { Crumbs } from '../../components/Crumbs';
import { fetchYearList, type YearListItem } from '../../routes/blocks/archive/fetch';

// Renders the shared <BlockTable> (same component the home ticker and
// the date archive use). The only difference here is the row count
// (PAGE_SIZE vs ~12 on home) and the analytics source on row clicks.

interface Block {
  height: number;
  hash: string;
  time: number;
  txCount: number;
  isPos: boolean;
  isSuperblock: boolean;
  isMrc: boolean;
  valueMoved?: string;
  feeTotal?: string;
  stakerCpid: string | null;
  // Server-side resolved BOINC display name for `stakerCpid` (the API
  // already serializes it; see presenters/index.ts). Used to seed
  // useCpidNames so the SSR rows show names on first paint; the hook
  // resolves SSE-arrived CPIDs client-side, same as LiveBlockTicker.
  stakerName?: string | null;
  minerAddress?: string | null;
  difficulty?: string;
  size?: number;
  mint?: string;
}

const PAGE_SIZE = 60;

interface BlocksListProps {
  initialRows: Block[];
  years: YearListItem[];
}

export default function BlocksList({ initialRows, years }: BlocksListProps) {
  const [rows, setRows] = useState<Block[]>(initialRows);

  // Live updates — same dedupe + descending-sort pattern as
  // LiveBlockTicker. Block payloads from SSE are snake_case; map onto
  // the camelCase shape the rest of the page uses.
  useSSE(['block.new'], (_topic, payload) => {
    const p = payload as {
      height: number; hash: string; time: number; tx_count: number;
      is_pos: boolean; is_superblock: boolean; is_mrc?: boolean;
      value_moved?: string; fee_total?: string;
      difficulty?: string; size?: number; mint?: string;
      staker_cpid: string | null; miner_address?: string | null;
    };
    const incoming: Block = {
      height: p.height,
      hash: p.hash,
      time: p.time,
      txCount: p.tx_count,
      isPos: p.is_pos,
      isSuperblock: p.is_superblock,
      isMrc: Boolean(p.is_mrc),
      valueMoved: p.value_moved ?? '0',
      feeTotal: p.fee_total ?? '0',
      difficulty: p.difficulty ?? '0',
      size: p.size ?? 0,
      mint: p.mint ?? '0',
      stakerCpid: p.staker_cpid,
      minerAddress: p.miner_address ?? null,
    };
    setRows((prev) => {
      const merged = [incoming, ...prev.filter((x) => x.hash !== incoming.hash)];
      merged.sort((x, y) => y.height - x.height);
      return merged.slice(0, PAGE_SIZE);
    });
  });

  // Staker display names — identical pattern to LiveBlockTicker. Seed
  // useCpidNames from the SSR-resolved `stakerName` on the initial rows
  // so the first paint already shows names, then let the hook resolve
  // any CPID that arrives later via SSE (its module cache fetches each
  // CPID at most once per session).
  const initialCpidNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of initialRows) {
      if (b.stakerCpid && b.stakerName) m[b.stakerCpid] = b.stakerName;
    }
    return m;
  }, [initialRows]);
  const stakerCpids = useMemo(
    () => rows
      .map((b) => b.stakerCpid)
      .filter((c): c is string => typeof c === 'string' && c.length > 0),
    [rows],
  );
  const names = useCpidNames(stakerCpids, initialCpidNames);

  // Map onto the shared BlockTable row. SSE rows carry no stakerName, so
  // prefer the live-resolved name and fall back to the SSR seed's.
  const tableRows: BlockRowData[] = useMemo(() => rows.map((b) => ({
    height: b.height,
    hash: b.hash,
    time: b.time,
    txCount: b.txCount,
    isPos: b.isPos,
    isSuperblock: b.isSuperblock,
    isMrc: b.isMrc,
    valueMoved: b.valueMoved ?? '0',
    feeTotal: b.feeTotal ?? '0',
    difficulty: b.difficulty ?? '0',
    size: b.size ?? 0,
    reward: b.mint ?? '0',
    stakerCpid: b.stakerCpid,
    stakerName: b.stakerCpid ? names.get(b.stakerCpid) ?? b.stakerName ?? null : null,
  })), [rows, names]);

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[{ label: 'Blocks' }]} />
        {years.length > 0 && <ArchiveRail years={years} />}
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Recent blocks</Typography>
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <BlockTable
            blocks={tableRows}
            minRows={PAGE_SIZE}
            emptyMessage="Waiting for the indexer to catch up to chain tip…"
            trackSource="block-list"
          />
        </Paper>
      </Stack>
    </Layout>
  );
}

/**
 * Archive nav rail. Year chips link into the date archive, giving
 * crawlers a path from /blocks into every year/month/day overview
 * page in three hops. Newest year first; chip color reflects relative
 * activity so the visual quickly maps "busy years" to "quiet years."
 */
function ArchiveRail({ years }: { years: YearListItem[] }) {
  const max = years.reduce((m, y) => Math.max(m, y.blockCount), 0);
  return (
    <Box sx={{ pb: 1 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: 11, display: 'block', mb: 1 }}
      >
        Browse the archive
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {years.map((y) => {
          const intensity = max > 0 ? y.blockCount / max : 0;
          return (
            <Link
              key={y.year}
              href={`/blocks/${y.year}`}
              style={{ textDecoration: 'none' }}
              prefetch={false}
            >
              <Chip
                size="small"
                clickable
                label={`${y.year} · ${y.blockCount.toLocaleString('en-US')}`}
                sx={{
                  bgcolor: (theme) => `rgba(${
                    parseInt(theme.palette.primary.main.slice(1, 3), 16)}, ${
                    parseInt(theme.palette.primary.main.slice(3, 5), 16)}, ${
                    parseInt(theme.palette.primary.main.slice(5, 7), 16)}, ${0.1 + intensity * 0.5})`,
                  color: 'text.primary',
                  fontWeight: 500,
                  '&:hover': { transform: 'translateY(-1px)' },
                  transition: 'transform 80ms ease',
                }}
              />
            </Link>
          );
        })}
      </Stack>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<BlocksListProps> = async () => {
  // Two independent calls — fan out so the page's TTFB is dominated by
  // whichever is slower (latest blocks list vs. years aggregate),
  // not their sum. Each falls back to empty on error so the page still
  // renders if one upstream is down.
  const [rowsResult, years] = await Promise.all([
    api.get('/blocks', { params: { 'page[size]': PAGE_SIZE } }).catch(() => null),
    fetchYearList(),
  ]);
  const data = (rowsResult?.data?.data ?? []) as Array<{ attributes: Block }>;
  return {
    props: {
      initialRows: data.map((d) => d.attributes),
      years,
    },
  };
};
