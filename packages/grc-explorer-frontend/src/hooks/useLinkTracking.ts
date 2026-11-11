import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { classifyLinkTarget } from '../lib/linkTarget';
import { track } from '../lib/track';

/**
 * One delegated listener for every internal link on the site, so in-page
 * links don't each need their own handler. Fires:
 *   - 'Entity Open' { type, from } for detail pages (block, tx, address…)
 *   - 'Link Click'  { to, from }   for any other internal page
 * `from` is the Next route pattern (e.g. /block/[height]), never the
 * concrete path. Outbound links are left to Plausible's automatic
 * outbound tracking, class-tagged links fire their own event, and the
 * header / nav menus already send 'Nav'.
 */
export function useLinkTracking(): void {
  const router = useRouter();
  const fromRef = useRef(router.pathname);
  fromRef.current = router.pathname;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.type === 'auxclick' && e.button !== 1) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.className.includes('plausible-event-name=')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      const from = fromRef.current;
      const target = classifyLinkTarget(url.pathname);
      if ('entity' in target) {
        track('Entity Open', { type: target.entity, from });
        return;
      }
      if (a.closest('header, [role="dialog"], [role="menu"]')) return;
      const samePageAnchor = url.pathname === window.location.pathname && url.hash !== '';
      track('Link Click', { to: samePageAnchor ? 'anchor' : target.to, from });
    };
    document.addEventListener('click', onClick);
    document.addEventListener('auxclick', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('auxclick', onClick);
    };
  }, []);
}
