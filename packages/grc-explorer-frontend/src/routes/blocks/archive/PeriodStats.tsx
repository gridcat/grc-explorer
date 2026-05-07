import {
  Card, CardContent, Stack, Typography,
} from '@mui/material';
import { formatNumber } from '../../../lib/format';
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
    { label: 'GRC moved',   value: formatGrcCompact(stats.valueMovedGrc) },
    { label: 'GRC minted',  value: formatGrcCompact(stats.mintTotalGrc) },
    { label: 'Fees (GRC)',  value: formatGrcCompact(stats.feeTotalGrc) },
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

// Compact "GRC moved" rendering — the raw decimal-string from CH (eg
// "12345678.12345678") is unreadable at-a-glance for >1k. Collapse to
// K/M/G/T with two decimals like the difficulty tile does.
function formatGrcCompact(grc: string): string {
  const n = Number(grc);
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n;
  let idx = -1;
  while (Math.abs(v) >= 1000 && idx < units.length - 1) {
    v /= 1000;
    idx += 1;
  }
  return `${v.toFixed(2)} ${units[idx]}`;
}
