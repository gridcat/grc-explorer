import {
  Box, Stack, Tooltip, Typography,
} from '@mui/material';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import Link from 'next/link';
import { useMemo } from 'react';
import { MONTHS_SHORT } from '../lib/format';

/**
 * Heatmap-style date archive grids. Two flavors:
 *
 *   <YearMonthGrid>  — 12 month tiles, used on /blocks/YYYY overview
 *   <MonthDayGrid>   — calendar grid of days, used on /blocks/YYYY/MM
 *
 * Each cell colors by `count` (block density) so periods of high vs.
 * quiet chain activity are visible at a glance — readable narrative
 * for the human eye, dense internal-link target for the crawler.
 *
 * Color grade: 5 stops from theme.palette.action.hover (zero) up to
 * theme.palette.primary.main (max). Density is normalised against the
 * largest count present in the same grid; switching grids resets
 * the gradient — relative within a period, not absolute over all time.
 */

interface Cell {
  /** Stable key for React reconciliation. */
  key: string;
  /** Visible label inside the cell (e.g. "Mar", "15"). Empty for blank slots. */
  label: string;
  /** Block count for density coloring. 0 → empty slot color. */
  count: number;
  /** Internal href to navigate to. Disable cells with no data by passing null. */
  href: string | null;
  /** Tooltip body — full stat row for the cell (e.g. "1,440 blocks · 2,100 txs"). */
  tooltip?: string;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function densityColor(theme: Theme, count: number, max: number): string {
  if (count === 0 || max === 0) return alpha(theme.palette.text.primary, 0.05);
  const t = Math.min(1, count / max);
  // 5 discrete stops keep neighbouring cells visually distinguishable —
  // a continuous gradient turns into a single fuzzy blob at low density.
  const stops = [0.12, 0.25, 0.45, 0.7, 1];
  const idx = stops.findIndex((s) => t <= s);
  const opacity = [0.18, 0.32, 0.5, 0.72, 1][idx === -1 ? 4 : idx];
  return alpha(theme.palette.primary.main, opacity);
}

function HeatCell({
  cell, max, size,
}: { cell: Cell; max: number; size: number }) {
  const theme = useTheme();
  const bg = densityColor(theme, cell.count, max);
  const isLink = cell.href !== null;
  const inner = (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: 1,
        bgcolor: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: cell.count > 0 ? 'primary.contrastText' : 'text.secondary',
        fontSize: { xs: 11, sm: 12 },
        fontWeight: 500,
        cursor: isLink ? 'pointer' : 'default',
        transition: 'transform 80ms ease',
        userSelect: 'none',
        '&:hover': isLink ? { transform: 'scale(1.08)' } : {},
        textDecoration: 'none',
      }}
    >
      {cell.label}
    </Box>
  );
  const wrapped = isLink ? (
    <Link href={cell.href as string} style={{ textDecoration: 'none', color: 'inherit' }}>
      {inner}
    </Link>
  ) : inner;
  return cell.tooltip
    ? <Tooltip title={cell.tooltip} arrow placement="top">{wrapped}</Tooltip>
    : wrapped;
}

/**
 * 12 month tiles for the year overview. Cells with count=0 render as
 * "no data" but still link — the destination month page will show its
 * own "no blocks indexed" state.
 */
export function YearMonthGrid({
  year, months, basePath = '/blocks',
}: {
  year: number;
  months: Array<{
    month: number; blockCount: number; txCount: number; superblockCount: number;
  }>;
  basePath?: string;
}) {
  const max = useMemo(
    () => months.reduce((m, x) => Math.max(m, x.blockCount), 0),
    [months],
  );
  const byMonth = new Map<number, typeof months[number]>();
  for (const m of months) byMonth.set(m.month, m);

  const cells: Cell[] = MONTHS_SHORT.map((name, i) => {
    const data = byMonth.get(i + 1);
    const count = data?.blockCount ?? 0;
    return {
      key: `m-${i + 1}`,
      label: name,
      count,
      href: count > 0 ? `${basePath}/${year}/${String(i + 1).padStart(2, '0')}` : null,
      tooltip: data
        ? `${count.toLocaleString('en-US')} blocks · ${data.txCount.toLocaleString('en-US')} txs · ${data.superblockCount} superblocks`
        : 'no blocks indexed',
    };
  });

  return (
    <Box sx={{
      display: 'grid',
      gridTemplateColumns: 'repeat(6, 1fr)',
      gap: { xs: 0.75, sm: 1 },
      maxWidth: 480,
    }}
    >
      {cells.map((c) => <HeatCell key={c.key} cell={c} max={max} size={64} />)}
    </Box>
  );
}

/**
 * Calendar grid of days for a month overview. Rows are weeks (Mon-Sun);
 * leading blank slots align the first of the month with its weekday
 * column. Days outside the month render as empty (non-interactive).
 */
export function MonthDayGrid({
  year, month, days, basePath = '/blocks',
}: {
  year: number;
  month: number;
  days: Array<{
    day: number; blockCount: number; txCount: number; superblockCount: number;
  }>;
  basePath?: string;
}) {
  const max = useMemo(
    () => days.reduce((m, x) => Math.max(m, x.blockCount), 0),
    [days],
  );
  const byDay = new Map<number, typeof days[number]>();
  for (const d of days) byDay.set(d.day, d);

  // Build the calendar grid:
  //   week-1 leading-blank cells based on weekday of day 1
  //   then 1..N for the month
  //   trailing blanks padded to a full week so the grid stays rectangular
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fmtMonth = String(month).padStart(2, '0');
  // toUTCDay() returns 0=Sun ... 6=Sat — convert to Mon-first (0=Mon ... 6=Sun)
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;

  const cells: Cell[] = [];
  for (let i = 0; i < leadingBlanks; i += 1) {
    cells.push({ key: `pre-${i}`, label: '', count: 0, href: null });
  }
  for (let d = 1; d <= daysInMonth; d += 1) {
    const data = byDay.get(d);
    const count = data?.blockCount ?? 0;
    cells.push({
      key: `d-${d}`,
      label: String(d),
      count,
      href: count > 0 ? `${basePath}/${year}/${fmtMonth}/${String(d).padStart(2, '0')}` : null,
      tooltip: data
        ? `${data.day} ${MONTHS_SHORT[month - 1]} ${year} · ${count.toLocaleString('en-US')} blocks · ${data.txCount.toLocaleString('en-US')} txs`
        : `${d} ${MONTHS_SHORT[month - 1]} ${year} · no blocks indexed`,
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ key: `post-${cells.length}`, label: '', count: 0, href: null });
  }

  return (
    <Stack spacing={1} sx={{ maxWidth: 360 }}>
      <Box sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr)',
        gap: 0.5,
      }}
      >
        {DAY_NAMES.map((dn) => (
          <Typography
            key={dn}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: 'center', fontSize: 10, textTransform: 'uppercase' }}
          >
            {dn}
          </Typography>
        ))}
      </Box>
      <Box sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr)',
        gap: 0.5,
      }}
      >
        {cells.map((c) => <HeatCell key={c.key} cell={c} max={max} size={42} />)}
      </Box>
    </Stack>
  );
}
