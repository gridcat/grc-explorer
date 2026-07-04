import {
  Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { Crumbs } from '../../components/Crumbs';
import { api } from '../../lib/api';
import { formatTime, nowSec } from '../../lib/format';
import {
  PAGE_SIZE_OPTIONS, pushPaginationQuery, readPageFromQuery, readPageSizeFromQuery,
} from '../../lib/pagination';

interface PollResult {
  topLabel: string | null;
  topPctOfCast: number;
  totalVotes: number;
  totalWeightCast: string;
}

interface Poll {
  pollId: string;
  title: string;
  question: string;
  startTime: number;
  endTime: number;
  result?: PollResult;
}

interface PollsListProps {
  initialRows: Poll[];
  initialTotal: number;
  initialPage: number;
  initialPageSize: number;
}

export default function PollsList({
  initialRows, initialTotal, initialPage, initialPageSize,
}: PollsListProps) {
  const router = useRouter();
  const [rows, setRows] = useState<Poll[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [loading, setLoading] = useState(false);

  const page = readPageFromQuery(router.query);
  const pageSize = readPageSizeFromQuery(router.query);

  // Skip the first client-side fetch — SSR already hydrated us with the
  // exact (page, pageSize) the URL asked for. Refetch only when the
  // user navigates to a different page/pageSize after mount.
  const initialKey = `${initialPage}/${initialPageSize}`;
  const lastFetchedKey = useRef(initialKey);

  useEffect(() => {
    const key = `${page}/${pageSize}`;
    if (key === lastFetchedKey.current) return;
    lastFetchedKey.current = key;
    let cancelled = false;
    setLoading(true);
    api.get('/polls', {
      params: { 'page[number]': page + 1, 'page[size]': pageSize },
    }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: Poll }>;
      setRows(data.map((d) => d.attributes));
      setTotal(Number(r.data?.meta?.count ?? 0));
    }).catch(() => {
      if (cancelled) return;
      setRows([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [page, pageSize]);

  const updateQuery = (next: { page?: number; pageSize?: number }) => {
    pushPaginationQuery(router, next);
  };

  const now = nowSec();

  return (
    <>
      <Seo
        title="Polls · Gridcoin Block Explorer"
        description="Gridcoin governance polls with voting weight, options and results."
        path="/polls"
      />
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[{ label: 'Polls' }]} />
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Governance polls</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            On-chain governance polls. Anyone with a beacon can put a
            question to the network, and any address with stake or
            magnitude can vote. The question, options, response type,
            weighting rule, and individual votes are all recorded as
            contracts in the chain. Active polls are still accepting
            votes; closed polls show the final tally as it stood when
            voting ended.
          </Typography>
        </Box>
        <Paper variant="outlined" sx={{ overflowX: 'auto', opacity: loading ? 0.6 : 1, transition: 'opacity 120ms' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Result</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Ends</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((p) => {
                const active = now >= p.startTime && now <= p.endTime;
                return (
                  <TableRow key={p.pollId} hover>
                    <TableCell sx={{ maxWidth: { xs: 200, sm: 320, md: 480 } }}>
                      {/*
                        User-supplied poll titles can be megabyte-scale or
                        unbreakable single-character runs (e.g. 50,000 quote
                        marks with no whitespace). Without `overflow-wrap:
                        anywhere` the browser refuses to break those at all
                        and the title pushes the table into horizontal scroll
                        territory; without the line-clamp a wrapped 50KB
                        title takes hundreds of vertical lines per row.
                        title=… is the native hover-tooltip with the full
                        original string for users who want to inspect it.
                      */}
                      <Box
                        component={Link}
                        href={`/polls/${p.pollId}`}
                        title={p.title}
                        sx={{
                          color: 'inherit',
                          textDecoration: 'inherit',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {p.title}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={active ? 'active' : 'closed'} color={active ? 'success' : 'default'} />
                    </TableCell>
                    <TableCell sx={{ maxWidth: { xs: 160, sm: 240 } }}>
                      <PollResultCell result={p.result} active={active} />
                    </TableCell>
                    <TableCell>{formatTime(p.startTime)}</TableCell>
                    <TableCell>{formatTime(p.endTime)}</TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No polls found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_, p) => updateQuery({ page: p })}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onRowsPerPageChange={(e) => updateQuery({ page: 0, pageSize: parseInt(e.target.value, 10) })}
          />
        </Paper>
      </Stack>
    </Layout>
    </>
  );
}

// Compact one-line result for each poll in the list. Closed polls
// show the winner; active polls show the current leader with an
// emphasis that the tally is still moving. No-vote polls fall back
// to an em-dash so the column doesn't render empty cells. Hover
// tooltip carries the full label + total weight cast for users who
// want the precise numbers.
function PollResultCell({
  result, active,
}: {
  result: PollResult | undefined;
  active: boolean;
}) {
  if (!result || result.topLabel === null || result.totalVotes === 0) {
    return (
      <Typography variant="body2" color="text.disabled">—</Typography>
    );
  }
  const verb = active ? 'Leading' : 'Winner';
  const pct = result.topPctOfCast.toFixed(1);
  const fullTitle = `${verb}: ${result.topLabel} · ${pct}% of ${result.totalWeightCast} GRC cast · ${result.totalVotes} vote${result.totalVotes === 1 ? '' : 's'}`;
  return (
    <Box title={fullTitle} sx={{ minWidth: 0 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: active ? 'warning.main' : 'text.primary',
        }}
      >
        {result.topLabel}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}
      >
        {`${pct}% · ${result.totalVotes} vote${result.totalVotes === 1 ? '' : 's'}`}
      </Typography>
    </Box>
  );
}

export const getServerSideProps: GetServerSideProps<PollsListProps> = async (ctx) => {
  const page = readPageFromQuery(ctx.query);
  const pageSize = readPageSizeFromQuery(ctx.query);
  try {
    const r = await api.get('/polls', {
      params: { 'page[number]': page + 1, 'page[size]': pageSize },
    });
    const data = (r.data?.data ?? []) as Array<{ attributes: Poll }>;
    const total = Number(r.data?.meta?.count ?? 0);
    return {
      props: {
        initialRows: data.map((d) => d.attributes),
        initialTotal: total,
        initialPage: page,
        initialPageSize: pageSize,
      },
    };
  } catch {
    return {
      props: {
        initialRows: [], initialTotal: 0, initialPage: page, initialPageSize: pageSize,
      },
    };
  }
};
