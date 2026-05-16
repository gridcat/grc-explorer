import type { NextRouter } from 'next/router';
import type { ParsedUrlQuery } from 'querystring';

/**
 * The list pages (polls, beacons, superblocks, …) share a uniform
 * `?page=&pageSize=` query contract + sx-on-options pattern. Helpers
 * here collapse the per-page triplicate of `readPageFromQuery`,
 * `readPageSizeFromQuery`, `clampPageSize`, and the
 * `router.replace({...query, page, pageSize}, undefined, {scroll:false, shallow:true})`
 * dance.
 */

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

export function clampPageSize(n: number, options: number[] = PAGE_SIZE_OPTIONS, fallback = DEFAULT_PAGE_SIZE): number {
  return options.includes(n) ? n : fallback;
}

export function readPageFromQuery(q: ParsedUrlQuery): number {
  const raw = parseInt((q.page as string) ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

export function readPageSizeFromQuery(
  q: ParsedUrlQuery,
  options: number[] = PAGE_SIZE_OPTIONS,
  fallback = DEFAULT_PAGE_SIZE,
): number {
  return clampPageSize(parseInt((q.pageSize as string) ?? '', 10) || fallback, options, fallback);
}

/**
 * Shallow-replace the URL with new pagination, preserving every other
 * query param. `scroll: false` keeps the user's scroll anchor;
 * `shallow: true` skips re-running getServerSideProps since the
 * client-side useEffect refetch already covers it.
 */
export function pushPaginationQuery(
  router: NextRouter,
  next: { page?: number; pageSize?: number },
): void {
  router.replace(
    {
      pathname: router.pathname,
      query: {
        ...router.query,
        ...(next.page !== undefined ? { page: String(next.page) } : {}),
        ...(next.pageSize !== undefined ? { pageSize: String(next.pageSize) } : {}),
      },
    },
    undefined,
    { scroll: false, shallow: true },
  );
}
