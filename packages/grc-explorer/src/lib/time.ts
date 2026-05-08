/**
 * Coerce a CH-emitted timestamp into unix seconds.
 *
 * `toUnixTimestamp(...)` columns from JSONEachRow can arrive as a
 * number, an ISO-formatted string (depending on driver/format quirks),
 * NULL, or undefined. This is the canonical converter used across the
 * read routes — keeps the conversion identical everywhere and makes
 * "what does this returned `null` mean?" a single-spot decision.
 */
export function tsToUnix(t: number | string | null | undefined): number | null {
  if (t === null || t === undefined) return null;
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
