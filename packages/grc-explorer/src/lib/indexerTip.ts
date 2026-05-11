import { ch } from './ch';

// Block-time of the indexer's most recent applied block, or 0 when the
// blocks table is empty. Used by routes and jobs that need to anchor
// "what does the dashboard mean by `now`?" on the indexer's progress
// rather than wall-clock — during a deep backfill those diverge by
// years, and showing today's peer count alongside a 2016-era tip would
// mislead the user.
export async function getIndexerTipTime(): Promise<number> {
  const result = await ch.query({
    query: 'SELECT max(time) AS t FROM blocks',
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ t: number | string | null }>();
  const raw = rows[0]?.t;
  if (raw === null || raw === undefined || raw === '' || raw === 0) return 0;
  // CH JSONEachRow returns DateTime as ISO string by default; coerce.
  const n = typeof raw === 'number' ? raw : Math.floor(new Date(raw).getTime() / 1000);
  return Number.isFinite(n) ? n : 0;
}

// If the indexer is more than ~5 minutes behind wall-clock, return its
// tip-time as the anchor; otherwise return wall-clock now. The 5-min
// threshold avoids flicking between modes during normal block cadence.
export async function getTipAnchor(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const tip = await getIndexerTipTime();
  if (tip > 0 && now - tip > 300) return tip;
  return now;
}

// Block-time of the first block at chain version ≥ 11 (the wallet's
// `g_v11_timestamp`). Returns null until the indexer has crossed the
// v11 boundary — during early backfill of a fresh CH this is normal.
//
// Used to gate beacon renewability: pre-v11 beacons (registered before
// this timestamp) cannot be renewed and must be re-advertised
// (src/gridcoin/beacon.cpp:~869). The /beacons route + UI should
// compare a beacon's `timestamp` against this value before showing a
// "renewable" badge.
//
// Cache invariant: this value is monotonic by chain rule (versions
// never bump downward), so once we see a non-null answer it can never
// change. Memoise on first hit; null answers we re-query each call so
// the boundary surfaces as soon as it lands.
//
// `pending` coalesces concurrent first-call waiters so two parallel
// requests during cold boot (e.g. /beacons list + /beacons/:cpid
// arriving on different connections of the same process) don't both
// issue the same CH query — the second await piggybacks on the first.
let cachedV11Timestamp: number | null = null;
let pendingV11Query: Promise<number | null> | null = null;

export async function getV11BlockTimestamp(): Promise<number | null> {
  if (cachedV11Timestamp !== null) return cachedV11Timestamp;
  if (pendingV11Query !== null) return pendingV11Query;
  pendingV11Query = (async () => {
    try {
      const result = await ch.query({
        query: 'SELECT toUnixTimestamp(min(time)) AS t FROM blocks WHERE n_version >= 11',
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ t: number | null }>();
      const raw = rows[0]?.t;
      if (raw === null || raw === undefined || raw === 0) return null;
      cachedV11Timestamp = Number(raw);
      return cachedV11Timestamp;
    } finally {
      pendingV11Query = null;
    }
  })();
  return pendingV11Query;
}
