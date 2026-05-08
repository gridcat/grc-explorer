import { Card, CardContent, Typography } from '@mui/material';

// Small label-over-value card used across dashboards. The h5/h6 split
// matches the two density modes the explorer uses today: `md` for
// hero stats, `sm` for stacked-grid panels.
export function Stat({
  label, value, size = 'md',
}: {
  label: string;
  value: string;
  size?: 'sm' | 'md';
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <Typography variant={size === 'md' ? 'h5' : 'h6'} sx={{ mt: 0.5, fontWeight: 700 }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}
