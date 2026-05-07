import Link from 'next/link';
import { ReactNode, CSSProperties } from 'react';

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
  // `color` defaults to inherit (the original "hand styling to parent"
  // shape used inside nav shells). External-link / standalone callers
  // can override with a CSS color or MUI palette path resolved by the
  // theme — the value is passed through to inline style as-is.
  color?: CSSProperties['color'];
  rel?: string;
  target?: string;
}

/**
 * Plain link that hands routing to next/link but hands styling control
 * to the parent. Used inside the nav-item shell from grcpay so MUI's
 * default link styling doesn't conflict with the underline-grow effect.
 */
export function NextMuiLink({
  href, children, className, color, rel, target,
}: Props) {
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
