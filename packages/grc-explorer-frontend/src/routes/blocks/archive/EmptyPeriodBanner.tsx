import { Box, Paper, Typography } from '@mui/material';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';

/**
 * Friendly empty state for year/month/day pages whose period has no
 * indexed blocks yet — typically because the indexer is still
 * backfilling earlier heights, or the user navigated to a period
 * before genesis.
 *
 * Renders only the banner (the page also pulls a `<meta robots
 * noindex>` so search engines skip indexing the empty shell).
 */
export function EmptyPeriodBanner({ period }: { period: string }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        bgcolor: 'action.hover',
        borderStyle: 'dashed',
      }}
    >
      <Box sx={{ color: 'text.secondary' }}>
        <HourglassEmptyIcon fontSize="large" />
      </Box>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
          No blocks indexed for {period}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Either the indexer hasn&apos;t caught up to this period yet,
          or it&apos;s before the chain&apos;s first block. Use the
          breadcrumb above or the navigation below to browse adjacent
          periods.
        </Typography>
      </Box>
    </Paper>
  );
}
