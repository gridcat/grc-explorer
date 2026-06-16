import {
  Box, Link as MuiLink, Paper, Stack, TablePagination, Typography,
} from '@mui/material';
import NextLink from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Layout } from '../../../layouts/Layout';
import { BlockTable, BlockRowData } from '../../../components/BlockTable';
import { Crumbs } from '../../../components/Crumbs';
import { formatNumber, MONTHS_FULL } from '../../../lib/format';
import { PeriodStatRow } from './PeriodStats';
import { EmptyPeriodBanner } from './EmptyPeriodBanner';
import type { DayArchiveData } from './types';

export function DayArchive({ data }: { data: DayArchiveData }) {
  const router = useRouter();
  const {
    year, month, day, blocks, pagination,
  } = data;
  // The archive is SSR-static, so the staker name is baked in server-side
  // (no useCpidNames hook) — just map straight onto the shared row shape.
  const tableRows: BlockRowData[] = blocks.map((b) => ({
    height: b.height,
    hash: b.hash,
    time: b.time,
    txCount: b.txCount,
    isPos: b.isPos,
    isSuperblock: b.isSuperblock,
    isMrc: b.isMrc,
    valueMoved: b.valueMoved,
    feeTotal: b.feeTotal,
    difficulty: b.difficulty,
    size: b.size,
    reward: b.mintGrc,
    stakerCpid: b.stakerCpid,
    stakerName: b.stakerName,
  }));
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
            {/* Shared <BlockTable> — same component the home ticker and
                /blocks listing use. Static age (not live) since the
                archive is SSR-only; names baked in server-side. */}
            <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
              <BlockTable blocks={tableRows} />
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
