// Pinning to en-US is what keeps SSR and CSR rendering identical: the
// Node container's default locale is C/POSIX (no thousands separators)
// while the browser uses the user's OS locale, and React's hydration
// check refuses to reconcile differing text. Same fix `formatTime` had
// to apply for timezones — explorer-wide content is chain-wide, not
// user-locale, so a fixed locale is correct semantically too.
const NUM_LOCALE = 'en-US';

// Hoisted Intl.NumberFormat instances — `Number.prototype.toLocaleString`
// instantiates a fresh formatter on every call, which is the dominant
// cost when rendering large tables / leaderboard rows.
const FMT_INT = new Intl.NumberFormat(NUM_LOCALE);
const FMT_GRC = new Intl.NumberFormat(NUM_LOCALE, { maximumFractionDigits: 8 });
const FMT_BY_DECIMALS = new Map<number, Intl.NumberFormat>();
function fmtWithDecimals(maximumFractionDigits: number): Intl.NumberFormat {
  let f = FMT_BY_DECIMALS.get(maximumFractionDigits);
  if (!f) {
    f = new Intl.NumberFormat(NUM_LOCALE, { maximumFractionDigits });
    FMT_BY_DECIMALS.set(maximumFractionDigits, f);
  }
  return f;
}

// Fixed-width fraction: min === max so every value is zero-padded to the
// same number of decimals. With `font-variant-numeric: tabular-nums`
// that makes the decimal point line up into a column down a table.
const FMT_FIXED_BY_DECIMALS = new Map<number, Intl.NumberFormat>();
function fmtFixedDecimals(decimals: number): Intl.NumberFormat {
  let f = FMT_FIXED_BY_DECIMALS.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat(NUM_LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    FMT_FIXED_BY_DECIMALS.set(decimals, f);
  }
  return f;
}

/** Current wall-clock time as unix seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Pretty-print a halford-as-string GRC value with a thousands separator.
 * Backend always sends amounts as strings to preserve 64-bit precision.
 */
export function formatGrc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const num = typeof s === 'number' ? s : Number(s);
  if (Number.isNaN(num)) return String(s);
  return FMT_GRC.format(num);
}

// Unicode digit → superscript map for scientific-notation rendering.
// Plain ASCII "e+64" reads like a programmer's float; "·10⁶⁴" reads
// like the textbook number every reader has met. Same characters
// render in any font, no MathJax or external dep.
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻',
};

function toSuperscript(exp: number): string {
  return String(exp).split('').map((c) => SUPERSCRIPT_DIGITS[c] ?? c).join('');
}

function formatScientific(abs: number): string {
  // log10 of a positive finite number is finite — no Infinity/NaN
  // branch needed. We round the exponent away from log10's tiny FP
  // drift (log10(1e6) returns 5.999999... on some engines).
  const exp = Math.floor(Math.log10(abs) + 1e-12);
  const mantissa = abs / 10 ** exp;
  const m = mantissa.toFixed(1);
  // `10⁶⁴` reads better than `1.0·10⁶⁴` — the mantissa is noise once
  // it rounds to unity.
  if (m === '1.0') return `10${toSuperscript(exp)}`;
  return `${m}·10${toSuperscript(exp)}`;
}

/**
 * Compact SI-prefix formatter capped at trillions. Beyond 1e15 we
 * render in scientific notation using Unicode superscripts —
 * `1.3·10⁶⁴` instead of `1.3e+64`. The pre-2015 Gridcoin chaos era
 * hits 10^64 difficulty before R Halford's retarget cap kicked in,
 * so every shared formatter has to be honest about that range
 * instead of pretending it fits a millions/billions narrative.
 *
 * Sub-1 values render as literal decimals with two-significant-figure
 * precision (`0.00024`, `0.5`) — early-chain difficulty year-lows sit
 * around 1e-4 and read better as a decimal than `2.4·10⁻⁴`. Scientific
 * only kicks in below 1e-9, which real chain data never reaches.
 */
export function formatCompact(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e15) return `${sign}${formatScientific(abs)}`;
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(decimals)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}${fmtWithDecimals(decimals).format(abs)}`;
  if (abs >= 1e-9) {
    // Two-significant-figure precision above the first non-zero digit,
    // floored at the caller's `decimals` so 0.5 doesn't lose its tail
    // when the caller asked for more places. Trim trailing zeros so
    // `0.0010` becomes `0.001` and `0.50` becomes `0.5`.
    const exp = Math.floor(Math.log10(abs));
    const digits = Math.max(2 - exp - 1, decimals);
    const formatted = abs.toFixed(digits)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
    return `${sign}${formatted}`;
  }
  return `${sign}${formatScientific(abs)}`;
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
  return FMT_INT.format(n);
}

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Format a CH `bucket_date` (`YYYY-MM-DD` string) as `D Mon YYYY`
 * for chart tooltips / axis ticks. Pinned to en-US month names so
 * SSR + CSR hydration match regardless of the host's locale.
 */
export function formatYmdDate(s: string): string {
  const [y, m, d] = s.split('-');
  const mi = parseInt(m, 10);
  const di = parseInt(d, 10);
  if (!Number.isFinite(mi) || !Number.isFinite(di) || mi < 1 || mi > 12) return s;
  return `${di} ${MONTHS_SHORT[mi - 1]} ${y}`;
}

/**
 * Format a unix-seconds timestamp as `D Mon YYYY` for tooltips. Same
 * en-US pin as `formatYmdDate` — `Date.toLocaleDateString` with the
 * host's default locale is the canonical SSR/CSR mismatch source.
 */
export function formatUnixDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Compact `D Mon` form for chart axis ticks. UTC-anchored. */
export function formatUnixDateShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** Locale-pinned compact integer (`Math.round(v).toLocaleString(NUM_LOCALE)`). */
export function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return FMT_INT.format(Math.round(v));
}

/**
 * GRC with thousand separators and at most two decimals — for tiles
 * and labels where full 8-digit precision is noise but K/M/G compact
 * form is too coarse. Locale-pinned to keep SSR + CSR identical.
 */
export function formatGrcShort(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return '—';
  return fmtFixedDecimals(2).format(n);
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
  const delta = Math.max(0, nowSec() - unixSec);
  return `${formatDuration(delta)} ago`;
}
