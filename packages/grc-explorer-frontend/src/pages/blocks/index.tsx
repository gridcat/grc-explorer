import {
  Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useSSE } from '../../hooks/useSSE';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatGrc, formatTime, timeAgo } from '../../lib/format';
import { track } from '../../lib/track';
import { Crumbs } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { fetchYearList, type YearListItem } from '../../routes/blocks/archive/fetch';

// Same table contract as the home page's LiveBlockTicker — same column
// names, widths, hash truncation, and badge layout. The only difference
// is the row count (50 here vs ~12 on home).

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
  minerAddress?: string | null;
  difficulty?: string;
}

const PAGE_SIZE = 60;

interface BlocksListProps {
  initialRows: Block[];
  years: YearListItem[];
}

export default function BlocksList({ initialRows, years }: BlocksListProps) {
  const router = useRouter();
  const [rows, setRows] = useState<Block[]>(initialRows);

  // Live updates — same dedupe + descending-sort pattern as
  // LiveBlockTicker. Block payloads from SSE are snake_case; map onto
  // the camelCase shape the rest of the page uses.
  useSSE(['block.new'], (_topic, payload) => {
    const p = payload as {
      height: number; hash: string; time: number; tx_count: number;
      is_pos: boolean; is_superblock: boolean; is_mrc?: boolean;
      value_moved?: string; fee_total?: string;
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
      stakerCpid: p.staker_cpid,
      minerAddress: p.miner_address ?? null,
    };
    setRows((prev) => {
      const merged = [incoming, ...prev.filter((x) => x.hash !== incoming.hash)];
      merged.sort((x, y) => y.height - x.height);
      return merged.slice(0, PAGE_SIZE);
    });
  });

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[{ label: 'Blocks' }]} />
        {years.length > 0 && <ArchiveRail years={years} />}
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Recent blocks</Typography>
        <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 110 }}>Height</TableCell>
                <TableCell>Hash</TableCell>
                <TableCell sx={{ width: 110 }}>Age</TableCell>
                <TableCell align="right" sx={{ width: 70 }}>Txs</TableCell>
                <TableCell align="right" sx={{ width: 110 }}>Amount</TableCell>
                <TableCell align="right" sx={{ width: 90 }}>Fees</TableCell>
                <TableCell sx={{ width: 130 }}>Type</TableCell>
                <TableCell sx={{ width: 140 }}>Staker</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow
                  key={b.hash}
                  hover
                  sx={{
                    cursor: 'pointer',
                    // Superblock rows are visually anchored: a brand-coloured
                    // left border bar + a stronger background tint so they
                    // stand out at a glance in a long list, since they hold
                    // the magnitude payouts everyone wants to find.
                    ...(b.isSuperblock && {
                      backgroundColor: (theme) => `${theme.palette.secondary.main}26`,
                      borderLeft: 4,
                      borderLeftColor: 'secondary.main',
                    }),
                  }}
                  onClick={() => {
                    if (b.isSuperblock) {
                      track('Superblock: open', { from: 'block-list' });
                      router.push(`/superblocks/${b.height}`);
                    } else {
                      track('Block: open', { from: 'block-list' });
                      router.push(`/block/${b.height}`);
                    }
                  }}
                  onMouseEnter={() => {
                    if (b.isSuperblock) router.prefetch(`/superblocks/${b.height}`);
                    else router.prefetch(`/block/${b.height}`);
                  }}
                >
                  <TableCell sx={{ fontWeight: 600 }}>
                    <Link
                      href={b.isSuperblock ? `/superblocks/${b.height}` : `/block/${b.height}`}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      #{b.height.toLocaleString('en-US')}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>
                    <HashTrim text={b.hash} head={12} tail={6} />
                  </TableCell>
                  <TableCell title={formatTime(b.time)} sx={{ color: 'text.secondary' }}>
                    {timeAgo(b.time)}
                  </TableCell>
                  <TableCell align="right">{b.txCount}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                    {formatGrc(b.valueMoved ?? '0')}
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                    {formatGrc(b.feeTotal ?? '0')}
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {b.isSuperblock && <Chip label="SB" size="small" color="secondary" />}
                      {b.isMrc && <Chip label="MRC" size="small" color="secondary" variant="outlined" />}
                      {b.isPos
                        ? <Chip label="PoS" size="small" variant="outlined" />
                        : <Chip label="PoW" size="small" variant="outlined" />}
                    </Box>
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {b.stakerCpid ? (
                      <Link
                        href={`/cpids/${b.stakerCpid}`}
                        style={{ color: 'inherit', textDecoration: 'none', fontFamily: 'monospace' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {b.stakerCpid}
                      </Link>
                    ) : (
                      <Box sx={{ color: 'text.disabled', fontStyle: 'italic' }}>investor</Box>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {/* Pad up to PAGE_SIZE so the table is always 50 rows
                  tall. Without this, the table grows from 1 row
                  (placeholder) to 50 when the API resolves, which
                  reflows the rest of the page and drags scroll. */}
              {Array.from({ length: Math.max(0, PAGE_SIZE - rows.length) }).map((_, i) => (
                <TableRow key={`pad-${i}`} sx={{ '& td': { borderColor: 'transparent' } }}>
                  <TableCell
                    colSpan={8}
                    sx={{
                      textAlign: 'center',
                      color: 'text.secondary',
                      height: 41,
                      py: 0,
                    }}
                  >
                    {i === 0 && rows.length === 0
                      ? 'Waiting for the indexer to catch up to chain tip…'
                      : ' '}
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
