import { Request } from 'express';
import { query } from './db';

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
    const rows = await query<{ height: number }>(
      'SELECT height FROM blocks ORDER BY height DESC LIMIT 1',
    );
    return rows[0]?.height ?? null;
  }
  const rows = await query<{ height: number }>(
    'SELECT height FROM blocks WHERE time <= FROM_UNIXTIME($at) ORDER BY height DESC LIMIT 1',
    { at },
  );
  return rows[0]?.height ?? null;
}

/**
 * Resolve the latest superblock height at-or-before `at`. Used by
 * /cpids and /metrics for magnitude snapshots — magnitudes are
 * keyed off the most recent superblock, not the current tip, so
 * "what was the magnitude leaderboard at time T?" needs the SB
 * cursor, not the block cursor.
 *
 * Live-mode (at === undefined) reads `superblocks FINAL` directly;
 * historical mode walks `blocks` because a non-superblock height
 * has no row in `superblocks` and we need the at-or-before
 * predicate to apply to chain time.
 */
export async function resolveAtSuperblockHeight(at: number | undefined): Promise<number | null> {
  if (at === undefined) {
    const rows = await query<{ height: number }>(
      'SELECT height FROM superblocks ORDER BY height DESC LIMIT 1',
    );
    return rows[0]?.height ?? null;
  }
  const rows = await query<{ height: number }>(
    `
      SELECT height FROM blocks
      WHERE is_superblock = true AND time <= FROM_UNIXTIME($at)
      ORDER BY height DESC LIMIT 1
    `,
    { at },
  );
  return rows[0]?.height ?? null;
}
