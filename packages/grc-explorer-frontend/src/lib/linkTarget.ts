/**
 * Classifies an internal link target for analytics. Detail pages map to
 * an entity type so the event never carries the id itself (no heights,
 * hashes, addresses or CPIDs). Archive pages collapse to their level.
 * Anything else is a static route and is kept as-is, unless it looks
 * like it could carry an identifier, in which case it becomes 'other'.
 */
const ENTITY_ROUTES: Array<[RegExp, string]> = [
  [/^\/block\/[^/]+$/, 'block'],
  [/^\/(?:transactions|tx)\/[^/]+$/, 'tx'],
  [/^\/addresses\/[^/]+$/, 'address'],
  [/^\/cpids\/[^/]+$/, 'cpid'],
  [/^\/superblocks\/[^/]+$/, 'superblock'],
  [/^\/polls\/[^/]+$/, 'poll'],
  [/^\/projects\/(?!history$)[^/]+$/, 'project'],
  [/^\/mandatory-sidestakes\/[^/]+$/, 'mandatory-sidestake'],
];

const ARCHIVE_ROUTES: Array<[RegExp, string]> = [
  [/^\/blocks\/\d{4}$/, 'archive-year'],
  [/^\/blocks\/\d{4}\/\d{2}$/, 'archive-month'],
  [/^\/blocks\/\d{4}\/\d{2}\/\d{2}$/, 'archive-day'],
];

export type LinkTarget = { entity: string } | { to: string };

export function classifyLinkTarget(pathname: string): LinkTarget {
  for (const [re, entity] of ENTITY_ROUTES) if (re.test(pathname)) return { entity };
  for (const [re, to] of ARCHIVE_ROUTES) if (re.test(pathname)) return { to };
  const safe = pathname.length <= 32 && /^\/[a-z/.-]*$/.test(pathname);
  return { to: safe ? pathname : 'other' };
}
