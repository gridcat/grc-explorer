import { Box } from '@mui/material';
import { ReactNode } from 'react';

/**
 * Dashed-border "no data yet" placeholder used by the home-page
 * widgets when their data feed hasn't returned anything (cold backfill
 * before V13 activates, no mempool entries in the last window, etc.).
 *
 * Centralised so all widgets stay visually consistent — the dashed
 * border + text-disabled colour are the same across the board, and
 * tweaking the placeholder treatment future-touches one file instead
 * of 5+.
 */
export function EmptyState({
  children,
  height,
}: {
  children: ReactNode;
  height?: number | string;
}) {
  return (
    <Box sx={{
      mt: 2,
      p: 2,
      borderRadius: 1,
      color: 'text.disabled',
      textAlign: 'center',
      border: 1,
      borderStyle: 'dashed',
      borderColor: 'divider',
      ...(height ? { height, display: 'flex', alignItems: 'center', justifyContent: 'center' } : {}),
    }}
    >
      {children}
    </Box>
  );
}
