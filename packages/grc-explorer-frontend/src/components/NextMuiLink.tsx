import Link from 'next/link';
import { ReactNode } from 'react';

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
}

/**
 * Plain link that hands routing to next/link but hands styling control
 * to the parent. Used inside the nav-item shell from grcpay so MUI's
 * default link styling doesn't conflict with the underline-grow effect.
 */
export function NextMuiLink({ href, children, className }: Props) {
  return (
    <Link href={href} className={className} style={{ color: 'inherit' }}>
      {children}
    </Link>
  );
}
