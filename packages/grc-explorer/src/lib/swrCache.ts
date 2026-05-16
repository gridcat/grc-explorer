/**
 * "Stale-while-revalidate"-style memoiser shared by routes that
 * cache an expensive build with an inflight-promise to coalesce
 * concurrent first-callers. After expiry the next caller pays the
 * rebuild cost; concurrent first-callers piggyback on the same
 * promise so a 30s rebuild isn't kicked off 18 times by an SSR
 * fan-out.
 *
 * Singleton form (no key argument):
 *
 *   const getThing = swrCached(buildThing, 60_000);
 *   const v = await getThing();
 *
 * Keyed form (one cache entry per key):
 *
 *   const getSeries = swrCachedKeyed(buildSeries, 60_000);
 *   const v = await getSeries(`year:${y}:${limit}`, () => buildSeries(...));
 *
 * Both forms surface build errors to the caller and DO NOT cache
 * failures — the next call retries fresh.
 *
 * The `*Live` variants additionally bypass the cache entirely unless
 * the indexer reports `status === 'live'`. While backfilling (or
 * mid-reorg) historical buckets are still changing, so a cached
 * aggregate would be served stale / poisoned — there we always
 * rebuild fresh and never read or write the memo. In live mode the
 * behaviour is identical to the plain variants.
 */
import { getCursor } from './redis';

export function swrCached<T>(build: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const v = await build();
        cached = { value: v, expiresAt: Date.now() + ttlMs };
        return v;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

export function swrCachedKeyed<T>(ttlMs: number): (key: string, build: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, { value: T; expiresAt: number }>();
  const inflight = new Map<string, Promise<T>>();
  return async (key, build) => {
    const now = Date.now();
    const c = cache.get(key);
    if (c && c.expiresAt > now) return c.value;
    const i = inflight.get(key);
    if (i) return i;
    const p = (async () => {
      try {
        const v = await build();
        cache.set(key, { value: v, expiresAt: Date.now() + ttlMs });
        return v;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

async function indexerLive(): Promise<boolean> {
  try {
    return (await getCursor())?.status === 'live';
  } catch {
    // Cursor unreadable → treat as not-live → bypass cache (correct
    // over fast: never serve a possibly-stale aggregate on doubt).
    return false;
  }
}

export function swrCachedLive<T>(build: () => Promise<T>, ttlMs: number): () => Promise<T> {
  const cached = swrCached(build, ttlMs);
  return async () => ((await indexerLive()) ? cached() : build());
}

export function swrCachedLiveKeyed<T>(
  ttlMs: number,
): (key: string, build: () => Promise<T>) => Promise<T> {
  const keyed = swrCachedKeyed<T>(ttlMs);
  return async (key, build) => ((await indexerLive()) ? keyed(key, build) : build());
}
