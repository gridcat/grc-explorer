import Link from 'next/link';
import { Link as MuiLink } from '@mui/material';
import { ReactNode, CSSProperties } from 'react';

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
  // `color` defaults to inherit (the original "hand styling to parent"
  // shape used inside nav shells). External-link / standalone callers
  // can override with a CSS color or MUI palette path resolved by the
  // theme.
  color?: CSSProperties['color'];
  rel?: string;
  target?: string;
  /**
   * Opt into MUI Link styling for in-prose use — adds the canonical
   * link affordance (underline-on-hover, themed `:visited`, focus
   * ring) that body text needs to surface a hyperlink as clickable.
   * Without this, the link inherits the surrounding text colour and
   * blends in — fine for nav shells with their own hover treatment,
   * wrong for paragraph-level links.
   */
  prose?: boolean;
}

/**
 * Two modes:
 *
 *  - Default: a bare `next/link` that hands all styling control to the
 *    parent. Used inside the nav-item shell so MUI's default link
 *    decoration doesn't fight the custom underline-grow effect.
 *
 *  - `prose`: MUI Link with `underline="hover"` and the caller's
 *    `color` (defaulting to `primary`). The standard text-link
 *    affordance used in paragraph copy (Terms, About, poll URLs,
 *    etc.) so links don't visually disappear into the prose.
 */
export function NextMuiLink({
  href, children, className, color, rel, target, prose,
}: Props) {
  if (prose) {
    return (
      <MuiLink
        component={Link}
        href={href}
        className={className}
        color={color ?? 'primary'}
        underline="hover"
        rel={rel}
        target={target}
      >
        {children}
      </MuiLink>
    );
  }
  return (
    <Link
      href={href}
      className={className}
      style={{ color: color ?? 'inherit' }}
      rel={rel}
      target={target}
    >
      {children}
    </Link>
  );
}
