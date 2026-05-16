import {
  Box, Chip, Link as MuiLink, Paper, Stack, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, Typography,
} from '@mui/material';
import NextLink from 'next/link';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Layout } from '../../../layouts/Layout';
import { HashTrim } from '../../../components/HashTrim';
import { Crumbs } from '../../../components/Crumbs';
import {
  formatNumber, formatTime, MONTHS_FULL, timeAgo,
} from '../../../lib/format';
import { PeriodStatRow } from './PeriodStats';
import { EmptyPeriodBanner } from './EmptyPeriodBanner';
import type { DayArchiveData } from './types';

export function DayArchive({ data }: { data: DayArchiveData }) {
  const router = useRouter();
  const {
    year, month, day, blocks, pagination,
  } = data;
  const monthName = MONTHS_FULL[month - 1];
  const isEmpty = data.blockCount === 0;
  const title = `Gridcoin blocks on ${day} ${monthName} ${year}`;
  const description = isEmpty
    ? `No Gridcoin blocks have been indexed for ${day} ${monthName} ${year} yet.`
    : `${formatNumber(data.blockCount)} blocks indexed on ${data.iso}, including ${formatNumber(data.txCount)} transactions.`;
  const fmt = (n: number): string => String(n).padStart(2, '0');
  const dayPath = `/blocks/${year}/${fmt(month)}/${fmt(day)}`;
  // Canonical strips ?page=1 — search engines should not index pagination
  // duplicates of the first page. ?page=2+ each get their own canonical
  // pointing at themselves.
  const canonical = pagination.pageNumber > 1 ? `${dayPath}?page=${pagination.pageNumber}` : dayPath;

  // Adjacent-day links are pure date math — JS Date handles month/year
  // rollover correctly when components are passed numerically.
  const prev = new Date(Date.UTC(year, month - 1, day - 1));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const prevHref = `/blocks/${prev.getUTCFullYear()}/${fmt(prev.getUTCMonth() + 1)}/${fmt(prev.getUTCDate())}`;
  const nextHref = `/blocks/${next.getUTCFullYear()}/${fmt(next.getUTCMonth() + 1)}/${fmt(next.getUTCDate())}`;

  // TablePagination indexes pages from 0; the server / URL use 1-based.
  // Translate at the boundary so the URL stays canonical (?page=2, not
  // ?page=1 which is implicit) and the SEO-friendly "no ?page" first
  // page matches the canonical-link logic above.
  const handlePageChange = (_e: unknown, zeroBased: number) => {
    const p = zeroBased + 1;
    router.push(p === 1 ? dayPath : `${dayPath}?page=${p}`, undefined, { scroll: true });
  };

  return (
    <Layout>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        {(pagination.pageNumber > 1 || isEmpty) && (
          <meta name="robots" content="noindex,follow" />
        )}
      </Head>
      <Stack spacing={3}>
        <Crumbs items={[
          { label: 'History', href: '/history' },
          { label: 'Blocks', href: '/blocks' },
          { label: String(year), href: `/blocks/${year}` },
          { label: monthName, href: `/blocks/${year}/${fmt(month)}` },
          { label: String(day) },
        ]}
        />

        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
            {day} {monthName} {year}
          </Typography>
          <Typography color="text.secondary">{description}</Typography>
        </Box>

        {isEmpty ? (
          <EmptyPeriodBanner period={`${day} ${monthName} ${year}`} />
        ) : (
          <>
            <PeriodStatRow stats={data} />
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              {/* Same column shape and styling as LiveBlockTicker (home)
                  and the /blocks listing — height / hash / age / txs /
                  type / staker. Click-anywhere row routing matches the
                  home page so the look-and-feel is uniform across the
                  three list contexts the user navigates between. */}
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
                        ...(b.isSuperblock && {
                          backgroundColor: (theme) => `${theme.palette.secondary.main}26`,
                          borderLeft: 4,
                          borderLeftColor: 'secondary.main',
                        }),
                      }}
                      onClick={() => {
                        if (b.isSuperblock) router.push(`/superblocks/${b.height}`);
                        else router.push(`/block/${b.height}`);
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
                          {`#${formatNumber(b.height)}`}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>
                        <HashTrim text={b.hash} head={12} tail={6} />
                      </TableCell>
                      <TableCell title={formatTime(b.time)} sx={{ color: 'text.secondary' }}>
                        {timeAgo(b.time)}
                      </TableCell>
                      <TableCell align="right">{b.txCount}</TableCell>
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          {b.isSuperblock && <Chip label="SB" size="small" color="secondary" />}
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
                </TableBody>
              </Table>
            </Paper>

            {pagination.totalPages > 1 && (
              <TablePagination
                component="div"
                count={data.blockCount}
                page={pagination.pageNumber - 1}
                onPageChange={handlePageChange}
                rowsPerPage={pagination.pageSize}
                rowsPerPageOptions={[pagination.pageSize]}
              />
            )}
          </>
        )}

        <Stack
          direction="row"
          spacing={2}
          sx={{
            pt: 2,
            borderTop: 1,
            borderColor: 'divider',
            alignItems: 'center',
          }}
        >
          <MuiLink
            component={NextLink}
            href={prevHref}
            underline="hover"
            color="primary"
            sx={{ fontWeight: 500 }}
          >
            ← prev day
          </MuiLink>
          <Box sx={{ flex: 1 }} />
          <MuiLink
            component={NextLink}
            href={`/blocks/${year}/${fmt(month)}`}
            underline="hover"
            color="text.secondary"
            sx={{ fontWeight: 500 }}
          >
            {`${monthName} ${year}`}
          </MuiLink>
          <Box sx={{ flex: 1 }} />
          <MuiLink
            component={NextLink}
            href={nextHref}
            underline="hover"
            color="primary"
            sx={{ fontWeight: 500 }}
          >
            next day →
          </MuiLink>
        </Stack>
      </Stack>
    </Layout>
  );
}
