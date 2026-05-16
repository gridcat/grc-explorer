import { useEffect, useMemo, useRef, useState } from 'react';
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

// Chunk size for the /cpids/names batch endpoint. Each CPID is 32
// hex chars + 1 comma = 33 bytes; 100 per call ≈ 3.3 KB of query
// string, comfortably under nginx's default 8 KB header limit and
// the server's per-batch cap of 500. A superblock detail page can
// resolve ~900 CPIDs by fanning out ~9 calls in parallel.
const NAMES_CHUNK_SIZE = 100;

async function fetchNamesChunk(unique: string[]): Promise<void> {
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

async function fetchNames(missing: string[]): Promise<void> {
  // CPIDs flow in from on-chain tables in mixed case
  // (`6Ebbae1E1973E2Ad…`) but `project_users` (BOINC source) keeps
  // them lowercase. Normalise here so the API key + cache key are
  // always the lowercase form — otherwise the regex filter drops
  // every mixed-case CPID and the hook silently returns nothing.
  const unique = Array.from(new Set(
    missing.map((c) => c.toLowerCase()).filter((c) => CPID_RE.test(c)),
  )).sort();
  if (unique.length === 0) return;
  // Chunk + parallel-fan so a superblock-detail page asking for
  // ~900 names doesn't slam a single 30 KB URL into the rejection
  // pile. Each chunk dedups against inflight independently so a
  // partial-overlap call later won't refetch chunks already mid-flight.
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += NAMES_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + NAMES_CHUNK_SIZE));
  }
  await Promise.all(chunks.map(fetchNamesChunk));
}

/**
 * SSR-side fetch: resolves a list of CPIDs to `{ cpid: name }` in one
 * batched call (chunked to respect the server's per-batch cap). Designed
 * for `getServerSideProps` — the result is then handed back as
 * `initialNames` to `useCpidNames` so the first paint already shows
 * names instead of truncated hashes.
 *
 * Missing / anonymous CPIDs are simply absent from the returned object;
 * callers should treat absence as "unknown".
 */
export async function fetchCpidNames(cpids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(
    cpids.map((c) => c.toLowerCase()).filter((c) => CPID_RE.test(c)),
  )).sort();
  if (unique.length === 0) return {};
  const out: Record<string, string> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += NAMES_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + NAMES_CHUNK_SIZE));
  }
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const r = await api.get<NamesResponse>('/cpids/names', { params: { cpids: chunk.join(',') } });
      const names = r.data?.data?.attributes?.names ?? {};
      for (const [k, v] of Object.entries(names)) {
        if (typeof v === 'string' && v) out[k] = v;
      }
    } catch {
      // Endpoint absent (fresh deploy pre-migration 0015) or transient
      // — return what we have; CSR hook will retry on mount.
    }
  }));
  return out;
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
export function useCpidNames(
  cpids: string[],
  initial?: Record<string, string>,
): Map<string, string> {
  // Hot path: home-page widgets feed ~900-CPID arrays here every
  // render. Skip the fingerprint + result-map rebuild unless `cpids`
  // actually changed (same instance → same output).
  const [, setTick] = useState(0);

  // Seed the module cache from SSR-provided names exactly once per
  // mount, synchronously before the first useMemo runs — so the first
  // render already returns names instead of waiting for the CSR batch
  // to come back. `useRef` ensures we never re-seed (which would
  // overwrite freshly-CSR-fetched values from the cache).
  const seededRef = useRef(false);
  if (!seededRef.current && initial) {
    for (const [k, v] of Object.entries(initial)) {
      const lc = k.toLowerCase();
      if (CPID_RE.test(lc) && typeof v === 'string' && v) {
        cache.set(lc, v);
      }
    }
    // `initial` is the server's resolution for the whole rendered set
    // (the API enriches every CPID-bearing resource with displayName).
    // So any CPID we're rendering that's absent from `initial` provably
    // has no published name — mark it null ("asked, none") so the
    // effect below doesn't re-fetch every anonymous CPID on each mount.
    // Without this the SSR prefetch elimination was incomplete: pages
    // with many nameless CPIDs (superblock detail ~900) still fired a
    // /cpids/names round trip every visit.
    for (const c of cpids) {
      const lc = c.toLowerCase();
      if (CPID_RE.test(lc) && !cache.has(lc)) {
        cache.set(lc, null);
      }
    }
    seededRef.current = true;
  }

  const { fingerprint, result } = useMemo(() => {
    // Stable cache-key from the sorted unique CPID list — depending
    // on `cpids` itself would re-run the effect on every render
    // because React compares array identity. Lowercased so the cache
    // and API key match `project_users`' canonical form.
    const fp = Array.from(new Set(
      cpids.map((c) => c.toLowerCase()).filter((c) => CPID_RE.test(c)),
    )).sort().join(',');

    // Map keyed by the caller's original case so existing consumers
    // (`names.get(r.cpid)`) keep working regardless of whether
    // `r.cpid` is the chain-cased or lowercase form.
    const m = new Map<string, string>();
    for (const c of cpids) {
      const v = cache.get(c.toLowerCase());
      if (typeof v === 'string') m.set(c, v);
    }
    return { fingerprint: fp, result: m };
  }, [cpids]);

  useEffect(() => {
    if (!fingerprint) return;
    const missing = fingerprint.split(',').filter((c) => !cache.has(c));
    if (missing.length === 0) return;
    fetchNames(missing).then(() => setTick((t) => t + 1));
  }, [fingerprint]);

  return result;
}
