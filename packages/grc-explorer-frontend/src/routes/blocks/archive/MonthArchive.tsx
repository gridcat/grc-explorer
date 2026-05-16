import {
  Box, Link as MuiLink, Stack, Typography,
} from '@mui/material';
import NextLink from 'next/link';
import Head from 'next/head';
import { Layout } from '../../../layouts/Layout';
import { MonthDayGrid } from '../../../components/CalendarHeatmap';
import { Crumbs } from '../../../components/Crumbs';
import { formatNumber, MONTHS_FULL } from '../../../lib/format';
import { PeriodStatRow } from './PeriodStats';
import { EmptyPeriodBanner } from './EmptyPeriodBanner';
import type { MonthArchiveData } from './types';

export function MonthArchive({ data }: { data: MonthArchiveData }) {
  const { year, month, days } = data;
  const monthName = MONTHS_FULL[month - 1];
  const isEmpty = data.blockCount === 0;
  const title = `Gridcoin in ${monthName} ${year} — block archive`;
  const description = isEmpty
    ? `No Gridcoin blocks have been indexed for ${monthName} ${year} yet.`
    : `${formatNumber(data.blockCount)} blocks and ${formatNumber(data.txCount)} transactions recorded in ${monthName} ${year}.`;
  const fmtMonth = String(month).padStart(2, '0');

  return (
    <Layout>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={`/blocks/${year}/${fmtMonth}`} />
        {isEmpty && <meta name="robots" content="noindex,follow" />}
      </Head>
      <Stack spacing={3}>
        <Crumbs items={[
          { label: 'History', href: '/history' },
          { label: 'Blocks', href: '/blocks' },
          { label: String(year), href: `/blocks/${year}` },
          { label: monthName },
        ]}
        />

        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, mb: 0.5 }}>
            {monthName} {year}
          </Typography>
          <Typography color="text.secondary">{description}</Typography>
        </Box>

        {isEmpty ? (
          <EmptyPeriodBanner period={`${monthName} ${year}`} />
        ) : (
          <>
            <PeriodStatRow stats={data} />
            <Box>
              <Typography variant="h6" sx={{ mb: 1, fontWeight: 600 }}>
                Days
              </Typography>
              <MonthDayGrid year={year} month={month} days={days} />
            </Box>
          </>
        )}

        <MonthNav year={year} month={month} />
      </Stack>
    </Layout>
  );
}

function MonthNav({ year, month }: { year: number; month: number }) {
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fmt = (m: number): string => String(m).padStart(2, '0');
  const navLinkSx = { fontWeight: 500 };
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
      <MuiLink
        component={NextLink}
        href={`/blocks/${prevYear}/${fmt(prevMonth)}`}
        underline="hover"
        color="primary"
        sx={navLinkSx}
      >
        ← prev month
      </MuiLink>
      <Box sx={{ flex: 1 }} />
      <MuiLink
        component={NextLink}
        href={`/blocks/${year}`}
        underline="hover"
        color="text.secondary"
        sx={navLinkSx}
      >
        {year}
      </MuiLink>
      <Box sx={{ flex: 1 }} />
      <MuiLink
        component={NextLink}
        href={`/blocks/${nextYear}/${fmt(nextMonth)}`}
        underline="hover"
        color="primary"
        sx={navLinkSx}
      >
        next month →
      </MuiLink>
    </Stack>
  );
}
