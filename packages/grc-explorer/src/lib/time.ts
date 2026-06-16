/**
 * Coerce a DB-emitted timestamp into unix seconds.
 *
 * Read routes surface time columns two ways, and this converter handles
 * both so the read path is identical everywhere:
 *   - raw TIMESTAMP columns (`SELECT *`) come back as
 *     'YYYY-MM-DD HH:MM:SS' strings — Date-parsed below;
 *   - `CAST(epoch(col) AS BIGINT)` columns come back as plain integer
 *     strings of unix seconds (DuckDB returns BIGINT as a decimal
 *     string, per lib/db getRowObjectsJson) — `new Date()` can't parse
 *     those, so a pure-integer string is taken as unix seconds directly.
 * NULL/undefined → null so callers can decide what a missing time means.
 */
export function tsToUnix(t: number | string | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  // epoch(...)::BIGINT arrives as an integer string of unix seconds.
  if (/^-?\d+$/.test(t.trim())) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
