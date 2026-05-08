import {
  Box, Breadcrumbs, Typography,
} from '@mui/material';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Site-wide breadcrumb component. Wraps MUI's <Breadcrumbs> with the
 * styling the project uses everywhere: chevron separator (subtle,
 * decorative), uppercase caption sizing, primary-colored hover for
 * intermediate links, full-strength text color for the current item.
 *
 * Usage:
 *   <Crumbs items={[
 *     { label: 'Blocks', href: '/blocks' },
 *     { label: '2024', href: '/blocks/2024' },
 *     { label: 'March' },        // last item: omit href, becomes current
 *   ]} />
 *
 * The last entry without an `href` is treated as the current page —
 * rendered as plain text in `text.primary`.
 */
export interface CrumbItem {
  label: ReactNode;
  /** Omit on the last item to render as the current page. */
  href?: string;
}

// Shared parent-section crumb for every page that lives under the
// "Researchers" nav menu. Centralising the (label, href) pair means
// renaming the section landing — or renaming the section itself —
// is a single-line edit, not a 14-site sweep.
export const RESEARCHERS_CRUMB: CrumbItem = { label: 'Researchers', href: '/superblocks' };

export function Crumbs({ items, sx }: { items: CrumbItem[]; sx?: object }) {
  return (
    <Box
      component="nav"
      aria-label="breadcrumb"
      sx={{
        // Slim vertical spacing — the breadcrumb sits right above a
        // page title so it shouldn't push the title down. Horizontal
        // padding inherits from the surrounding Layout.
        py: 0.5,
        ...sx,
      }}
    >
      <Breadcrumbs
        separator={(
          <NavigateNextIcon
            fontSize="inherit"
            sx={{
              color: 'text.disabled',
              fontSize: 14,
              mx: -0.25,
            }}
          />
        )}
        aria-label="breadcrumb"
        sx={{
          '& .MuiBreadcrumbs-ol': {
            alignItems: 'center',
          },
          '& .MuiBreadcrumbs-li': {
            display: 'inline-flex',
            alignItems: 'center',
          },
          '& .MuiBreadcrumbs-separator': {
            mx: 0.5,
          },
        }}
      >
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          if (isLast || !item.href) {
            return (
              <Typography
                key={idx}
                component="span"
                sx={{
                  fontSize: { xs: 11.5, sm: 12.5 },
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: 'text.primary',
                }}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </Typography>
            );
          }
          return (
            <Link
              key={idx}
              href={item.href}
              style={{ textDecoration: 'none' }}
            >
              <Typography
                component="span"
                sx={{
                  fontSize: { xs: 11.5, sm: 12.5 },
                  fontWeight: 500,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                  transition: 'color 80ms ease',
                  '&:hover': {
                    color: 'primary.main',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                  },
                }}
              >
                {item.label}
              </Typography>
            </Link>
          );
        })}
      </Breadcrumbs>
    </Box>
  );
}
