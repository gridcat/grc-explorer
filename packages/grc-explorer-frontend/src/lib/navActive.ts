// Active-nav resolution for grouped menus. A child is "current" when its
// href is the *longest* match for the current pathname — exact, or a
// parent of it on a `/` boundary. Longest-match is what stops a parent
// child like `/wallets` from also lighting up on `/wallets/versions`
// (a plain startsWith would mark both). Section detail pages still
// highlight their parent (`/beacons/<id>` → `/beacons`) because that's
// the longest (and only) match there.
export function activeChildHref(
  pathname: string,
  children: ReadonlyArray<{ href: string }>,
): string | null {
  let best: string | null = null;
  for (const c of children) {
    if (pathname === c.href || pathname.startsWith(`${c.href}/`)) {
      if (best === null || c.href.length > best.length) best = c.href;
    }
  }
  return best;
}
