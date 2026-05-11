import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Module-level in-memory cache. Names rarely change (a user only
// edits their BOINC profile occasionally), and the home page mounts
// multiple components that all surface the same top researchers —
// caching across mounts keeps the leaderboard, top movers and the
// ticker all benefiting from a single round trip.
//
// A `null` cache entry means "we asked and there's no name" (either
// anonymous or not yet imported). That's distinct from "we haven't
// asked yet" (key absent). Treating them the same would spam the
// endpoint with re-fetches for anonymous CPIDs on every refresh.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();

const CPID_RE = /^[0-9a-f]{32}$/;

interface NamesResponse {
  data?: { attributes?: { names?: Record<string, string> } };
}

async function fetchNames(missing: string[]): Promise<void> {
  // De-dup + canonicalise into a stable cache key so two components
  // requesting the same set hit one in-flight promise.
  const unique = Array.from(new Set(missing.filter((c) => CPID_RE.test(c)))).sort();
  if (unique.length === 0) return;
  const key = unique.join(',');
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const r = await api.get<NamesResponse>('/cpids/names', { params: { cpids: key } });
      const names = r.data?.data?.attributes?.names ?? {};
      for (const c of unique) {
        cache.set(c, typeof names[c] === 'string' ? names[c] : null);
      }
    } catch {
      // Network/route absent — mark all as unknown so we don't
      // retry tight-loop. Next page load gets a fresh chance.
      for (const c of unique) {
        if (!cache.has(c)) cache.set(c, null);
      }
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * Resolve a list of CPIDs to their BOINC display names. Returns a
 * `Map<cpid, name>` containing only CPIDs that have a non-empty
 * published name. The caller treats missing entries as
 * "anonymous / unknown" and falls back to the truncated CPID hash
 * via the CpidLabel component.
 *
 * Re-renders the calling component when fresh names arrive from the
 * batch endpoint. Module-level cache means a CPID is fetched at most
 * once per browser session regardless of how many widgets ask for it.
 */
export function useCpidNames(cpids: string[]): Map<string, string> {
  // Stable cache-key from the sorted unique CPID list — depending on
  // `cpids` itself would re-run the effect on every render because
  // React compares array identity.
  const fingerprint = Array.from(new Set(cpids.filter((c) => CPID_RE.test(c)))).sort().join(',');
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!fingerprint) return;
    const missing = fingerprint.split(',').filter((c) => !cache.has(c));
    if (missing.length === 0) return;
    fetchNames(missing).then(() => setTick((t) => t + 1));
  }, [fingerprint]);

  const result = new Map<string, string>();
  for (const c of cpids) {
    const v = cache.get(c);
    if (typeof v === 'string') result.set(c, v);
  }
  return result;
}
