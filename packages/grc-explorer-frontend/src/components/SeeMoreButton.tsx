import { Button } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Link from 'next/link';

/**
 * "See all →" / "History →" header-corner button used by every home-
 * page tile that has a deeper view. Centralised so all the tiles
 * share the same chevron treatment + sx instead of each maintaining
 * its own copy.
 */
export function SeeMoreButton({ href, label = 'See all' }: { href: string; label?: string }) {
  return (
    <Button
      component={Link}
      href={href}
      size="small"
      color="primary"
      endIcon={<ChevronRightIcon fontSize="small" />}
      sx={{
        textTransform: 'none', fontSize: 13, fontWeight: 500, minWidth: 0, px: 1, py: 0.25,
      }}
    >
      {label}
    </Button>
  );
}
