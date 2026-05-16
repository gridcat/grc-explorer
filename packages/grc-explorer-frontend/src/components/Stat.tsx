import type { ReactNode } from 'react';
import { Card, CardContent, Typography } from '@mui/material';

// Small label-over-value card used across dashboards. The h5/h6 split
// matches the two density modes the explorer uses today: `md` for
// hero stats, `sm` for stacked-grid panels. `value` accepts ReactNode
// so callers can stack a primary value with a small caption underneath
// (e.g. "#123" + a human-readable date) — typical strings still work.
export function Stat({
  label, value, size = 'md',
}: {
  label: string;
  value: ReactNode;
  size?: 'sm' | 'md';
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography
          variant={size === 'md' ? 'h5' : 'h6'}
          sx={{ mt: 0.5, fontWeight: 700 }}
          component="div"
        >
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}
