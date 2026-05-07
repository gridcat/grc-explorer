import {
  Box, Link as MuiLink, Stack, Typography,
} from '@mui/material';
import NextLink from 'next/link';
import Head from 'next/head';
import { Layout } from '../../../layouts/Layout';
import { YearMonthGrid } from '../../../components/CalendarHeatmap';
import { Crumbs } from '../../../components/Crumbs';
import { formatNumber } from '../../../lib/format';
import { PeriodStatRow } from './PeriodStats';
import { ArticleBody, type ArticleData, type ArticleStats } from './Article';
import { EmptyPeriodBanner } from './EmptyPeriodBanner';
import type { YearArchiveData } from './types';

/**
 * Year overview page — `/blocks/YYYY`.
 *
 * The article body (when present) renders above the data grid; the
 * data grid alone is enough to be a useful page even without prose.
 * That's the "infrastructure ships value before content" property —
 * we get the SEO win immediately and editorial work happens in the
 * background.
 */
export function YearArchive({
  data, prevYear = null, nextYear = null, article = null,
}: {
  data: YearArchiveData;
  /** Adjacent years that have indexed data, computed at SSR time from
   *  the full year list. null = no neighbour in that direction (e.g.
   *  prevYear is null on the oldest indexed year). The arrows skip
   *  rendering when their target is null, so users never click into
   *  a guaranteed-empty page. */
  prevYear?: number | null;
  nextYear?: number | null;
  /** Optional editorial article for this year — when null the page
   *  still renders as a usable data overview. The infra ships value
   *  before the content is authored. */
  article?: ArticleData | null;
}) {
  const { year, months } = data;
  const isEmpty = data.blockCount === 0;
  // Stats exposed to {{stat:KEY}} placeholders inside the article body.
  // Numbers get a US-locale string so the article reads naturally
  // ("1,234 blocks") and stays SSR/CSR-deterministic.
  const articleStats: ArticleStats = {
    total_blocks: formatNumber(data.blockCount),
    total_txs: formatNumber(data.txCount),
    total_superblocks: formatNumber(data.superblockCount),
    grc_moved: data.valueMovedGrc,
    grc_minted: data.mintTotalGrc,
  };
  const title = `Gridcoin in ${year} — block archive`;
  const description = isEmpty
    ? `No Gridcoin blocks have been indexed for ${year} yet.`
    : `${formatNumber(data.blockCount)} blocks, ${formatNumber(data.txCount)} transactions, and ${formatNumber(data.superblockCount)} superblocks recorded on the Gridcoin chain in ${year}.`;

  return (
    <Layout>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={`/blocks/${year}`} />
        {isEmpty && <meta name="robots" content="noindex,follow" />}
      </Head>
      <Stack spacing={3}>
        <Crumbs items={[
          { label: 'History', href: '/history' },
          { label: 'Blocks', href: '/blocks' },
          { label: String(year) },
        ]}
        />

        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
            Gridcoin in {year}
          </Typography>
          <Typography color="text.secondary">
            {description}
          </Typography>
        </Box>

        {/* Article renders before the on-chain data section so years
            without indexed blocks (e.g. 2013, the Gridcoin Classic
            predecessor chain) can still carry meaningful content —
            historical/contextual prose isn't gated on chain data. */}
        {article && <ArticleBody article={article} stats={articleStats} />}

        {isEmpty ? (
          <EmptyPeriodBanner period={String(year)} />
        ) : (
          <>
            <PeriodStatRow stats={data} />
            <Box>
              <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
                Months
              </Typography>
              <YearMonthGrid year={year} months={months} />
            </Box>
          </>
        )}

        {(prevYear !== null || nextYear !== null) && (
          <ArchiveNav prevYear={prevYear} nextYear={nextYear} />
        )}
      </Stack>
    </Layout>
  );
}

function ArchiveNav({
  prevYear, nextYear,
}: { prevYear: number | null; nextYear: number | null }) {
  return (
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
      {prevYear !== null ? (
        <MuiLink
          component={NextLink}
          href={`/blocks/${prevYear}`}
          underline="hover"
          color="primary"
          sx={{ fontWeight: 500 }}
        >
          {`← ${prevYear}`}
        </MuiLink>
      ) : <Box />}
      <Box sx={{ flex: 1 }} />
      {nextYear !== null ? (
        <MuiLink
          component={NextLink}
          href={`/blocks/${nextYear}`}
          underline="hover"
          color="primary"
          sx={{ fontWeight: 500 }}
        >
          {`${nextYear} →`}
        </MuiLink>
      ) : <Box />}
    </Stack>
  );
}
