/**
 * Coerce a value of unknown shape — typically `Prisma.Decimal` from a
 * `$queryRaw` SUM(BIGINT) (which MySQL returns as DECIMAL because the
 * sum can overflow BIGINT range) — into a `bigint`. Goes via the string
 * representation so values larger than `Number.MAX_SAFE_INTEGER`
 * round-trip exactly. Decimal fractions are truncated.
 */
export function toBigInt(v: unknown): bigint {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  const s = String(v);
  if (s.length === 0) return 0n;
  const dot = s.indexOf('.');
  return BigInt(dot >= 0 ? s.slice(0, dot) : s);
}
