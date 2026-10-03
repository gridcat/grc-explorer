import type { IncomingMessage, ServerResponse } from 'http';

// SSR-side helpers shared by the detail pages: what to tell the edge
// cache about a rendered page, and how to keep the visitor's identity
// on the API calls made on their behalf.

/**
 * Confirmations after which a block / transaction page is treated as
 * settled. Mirrors the API's DETAIL_CACHE_DEPTH (routes/blocks.ts):
 * deeper than MAX_REORG_DEPTH, no reorg can reach it.
 */
export const SETTLED_DEPTH = 120;

/** Seconds a shared cache (nginx, CDN) may serve a page without asking. */
export const PAGE_TTL = {
  /**
   * Settled block / tx: only a deploy changes it. Kept to an hour on
   * purpose — the runbook's purge-on-deploy covers markup changes.
   */
  settled: { maxAge: 3600, swr: 600 },
  /** Shallow block / tx: the confirmation count is still moving. */
  fresh: { maxAge: 30, swr: 30 },
  /** Address: balance moves; the client refetches after hydration anyway. */
  address: { maxAge: 60, swr: 300 },
  /** Paginated lists (polls, …): a new row lands per block at most; a minute stale is invisible. */
  list: { maxAge: 60, swr: 300 },
} as const;

/** Seconds after a poll's end before its page counts as settled (late votes indexed, weights computed). */
export const POLL_SETTLE_GRACE = 86_400;

export type PageTtl = (typeof PAGE_TTL)[keyof typeof PAGE_TTL];

/**
 * `max-age=0` keeps browsers revalidating so a visitor never sees a
 * stale page from their own history; `s-maxage` is what nginx and CDNs
 * read. Next's default for SSR pages is `no-store`, so without this
 * nothing caches anywhere.
 */
export function cacheControl(ttl: PageTtl): string {
  return `public, max-age=0, s-maxage=${ttl.maxAge}, stale-while-revalidate=${ttl.swr}`;
}

export function setPageCache(res: ServerResponse, ttl: PageTtl): void {
  res.setHeader('Cache-Control', cacheControl(ttl));
}

/** Pick the block / tx TTL from how deep the chain has buried it. */
export function depthTtl(confirmations: number): PageTtl {
  return confirmations >= SETTLED_DEPTH ? PAGE_TTL.settled : PAGE_TTL.fresh;
}

/**
 * Headers to attach to SSR API calls. Without them every SSR request
 * reaches the API as the frontend container with an axios User-Agent,
 * so the API's per-IP rate limiter throttles the whole site as one
 * client and its access log cannot name the visitor. nginx overwrites
 * X-Forwarded-For with the real client (snippets/gc-proxy.conf), so
 * the first entry is trustworthy here.
 */
export function clientHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  const xff = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress;
  if (ip) headers['X-Forwarded-For'] = ip;
  const ua = req.headers['user-agent'];
  if (ua) headers['User-Agent'] = ua;
  return headers;
}
