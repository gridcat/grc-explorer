// Pinning to en-US is what keeps SSR and CSR rendering identical: the
// Node container's default locale is C/POSIX (no thousands separators)
// while the browser uses the user's OS locale, and React's hydration
// check refuses to reconcile differing text. Same fix `formatTime` had
// to apply for timezones — explorer-wide content is chain-wide, not
// user-locale, so a fixed locale is correct semantically too.
const NUM_LOCALE = 'en-US';

/**
 * Pretty-print a halford-as-string GRC value with a thousands separator.
 * Backend always sends amounts as strings to preserve 64-bit precision.
 */
export function formatGrc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const num = typeof s === 'number' ? s : Number(s);
  if (Number.isNaN(num)) return String(s);
  return num.toLocaleString(NUM_LOCALE, { maximumFractionDigits: 8 });
}

/**
 * Compact SI-prefix formatter capped at trillions. Beyond 1e15 we fall
 * back to a clean 2-significant-digit exponential ("1.0e+64", "1.7e-9")
 * rather than letting `toFixed` emit a 15-digit mantissa welded to a
 * unit suffix ("1.291165483285982e+58M"). The pre-2015 Gridcoin chaos
 * era hits 10^64 difficulty before R Halford's retarget cap kicked in,
 * so every shared formatter has to be honest about that range instead
 * of pretending it fits a millions/billions narrative.
 */
export function formatCompact(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e15 || abs < 1e-3) return `${sign}${abs.toExponential(1)}`;
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(decimals)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}${abs.toLocaleString(NUM_LOCALE, { maximumFractionDigits: decimals })}`;
  return `${sign}${abs.toPrecision(2)}`;
}

/**
 * Compact GRC formatter for charts/axes — `1.2M`, `3.4K`, `567` — where
 * thousands-separated full-precision noise hurts readability. Used by the
 * dashboard's SVG charts (Y-axis ticks, tooltips, address sparkline).
 */
export function formatGrcCompact(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  return formatCompact(n, 2);
}

/**
 * Locale-pinned number formatter for everything that previously called
 * `n.toLocaleString()` directly in render. Same hydration argument as
 * formatGrc above — render output must match SSR vs CSR exactly.
 */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString(NUM_LOCALE);
}

export function shortHash(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Render a unix-seconds timestamp in a deterministic UTC format. Using
 * the runtime's local locale/TZ (the previous `toLocaleString()`) made
 * SSR and client disagree whenever the browser was in a different TZ
 * than the Node server, causing React hydration mismatch warnings.
 * UTC is the convention for blockchain explorers anyway — every block
 * timestamp is a chain-wide value, not a user-local one.
 */
export function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

/**
 * Format a duration in seconds with a human-friendly unit. Picks one
 * unit based on magnitude — never spells out "X hours Y minutes".
 *
 * Tier boundaries are at 1.5× the next unit (date-fns convention) and
 * rounding is applied within the chosen tier. This way 35 months reads
 * as "3y", not "2y" — flooring would lose nearly a full year at every
 * unit boundary, most visibly in the year tier.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h`;
  if (s < 11 * 86400) return `${Math.round(s / 86400)}d`;
  if (s < 45 * 86400) return `${Math.round(s / (86400 * 7))}w`;
  if (s < 548 * 86400) return `${Math.round(s / (86400 * 30))}mo`;
  return `${Math.round(s / (86400 * 365))}y`;
}

export function timeAgo(unixSec: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  return `${formatDuration(delta)} ago`;
}
