import { styled } from '@mui/material/styles';

/**
 * Brand accent — a short gradient bar. Shown on mobile above page hero
 * sections to introduce the gradient identity (which the desktop logo
 * already carries). Mirrors the grcpay/stamp pattern.
 */
export const GradientLine = styled('div')(({ theme }) => ({
  backgroundImage: `linear-gradient(to right, ${theme.palette.primary.dark}, ${theme.palette.primary.light})`,
  width: 100,
  height: 4,
  borderRadius: 2,
  marginTop: theme.spacing(6),
  marginBottom: theme.spacing(4),
  [theme.breakpoints.up('sm')]: {
    display: 'none',
  },
}));
