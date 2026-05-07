import { Request } from 'express';
import { ch } from './ch';

/**
 * Parse a unix-seconds query parameter. The whole time-machine surface
 * (route handlers, jobs that simulate at a moment) uses this single
 * parser so the rules don't drift.
 */
export function parseUnixSeconds(req: Request, key: string): number | undefined {
  const raw = req.query[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Convenience for the canonical `?at=<unix-seconds>` parameter. */
export function parseAt(req: Request): number | undefined {
  return parseUnixSeconds(req, 'at');
}

/**
 * Resolve `at` (unix seconds) to the latest block height the indexer
 * had reached at or before that moment. The bitemporal queries all key
 * off block height — they need an integer cursor, not a wall-clock time
 * — so this is the universal hop from time → height.
 *
 * Returns null when `at` is set but no indexed block predates it (the
 * indexer hasn't reached that part of the chain yet). Callers that get
 * null should treat it as "no data at that moment", typically returning
 * an empty payload.
 *
 * Live-mode callers pass `at = undefined` and get the latest indexed
 * height; that lets every route handler take a uniform shape regardless
 * of replay vs live.
 */
export async function resolveAtHeight(at: number | undefined): Promise<number | null> {
  if (at === undefined) {
    const result = await ch.query({
      query: 'SELECT height FROM blocks FINAL ORDER BY height DESC LIMIT 1',
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ height: number }>();
    return rows[0]?.height ?? null;
  }
  const result = await ch.query({
    query: 'SELECT height FROM blocks FINAL WHERE time <= toDateTime({at: UInt32}) ORDER BY height DESC LIMIT 1',
    query_params: { at },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ height: number }>();
  return rows[0]?.height ?? null;
}
