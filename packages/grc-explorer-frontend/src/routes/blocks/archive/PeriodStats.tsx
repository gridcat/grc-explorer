import {
  Card, CardContent, Stack, Typography,
} from '@mui/material';
import { formatGrcCompact, formatNumber } from '../../../lib/format';
import type { ArchivePeriodStats } from './types';

/**
 * Headline stat row shared across year / month / day overview pages.
 * Renders the same six tiles in the same order everywhere — visual
 * consistency lets a returning visitor compare 2018 ↔ 2024 ↔ 2024-03 at
 * a glance without re-orienting.
 */
export function PeriodStatRow({ stats }: { stats: ArchivePeriodStats }) {
  const tiles: Array<{ label: string; value: string }> = [
    { label: 'Blocks',      value: formatNumber(stats.blockCount) },
    { label: 'Transactions', value: formatNumber(stats.txCount) },
    { label: 'Superblocks', value: formatNumber(stats.superblockCount) },
    { label: 'GRC moved',   value: formatGrcCompact(Number(stats.valueMovedGrc)) },
    { label: 'GRC minted',  value: formatGrcCompact(Number(stats.mintTotalGrc)) },
    { label: 'Fees (GRC)',  value: formatGrcCompact(Number(stats.feeTotalGrc)) },
  ];
  return (
    <Stack direction="row" spacing={{ xs: 1, sm: 2 }} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {tiles.map((t) => (
        <Card
          key={t.label}
          variant="outlined"
          sx={{
            flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 160px' },
            minWidth: { xs: 0, sm: 160 },
          }}
        >
          <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
            >
              {t.label}
            </Typography>
            <Typography
              sx={{
                mt: 0.5,
                fontWeight: 600,
                fontSize: { xs: '1.05rem', sm: '1.5rem' },
                lineHeight: 1.25,
              }}
            >
              {t.value}
            </Typography>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

