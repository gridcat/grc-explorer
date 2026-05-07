import { config } from '../config';

// Gridcoin RPC returns amounts as JSON numbers in GRC. Working in GRC
// is a parade of float-precision footguns (0.1 + 0.2 ≠ 0.3, comparing
// received vs required, summing thousands of vouts). We convert to
// integer halford on the boundary and never look back.

const HALFORD = BigInt(config.HALFORD);

/**
 * Convert a GRC amount (as it arrives from the daemon — `number` or
 * `string`) to halford BigInt.
 */
export function grc2halford(grc: number | string): bigint {
  const s = typeof grc === 'number' ? grc.toFixed(8) : grc;
  const negative = s.startsWith('-');
  const cleaned = negative ? s.slice(1) : s;
  const [intPart, fracPart = ''] = cleaned.split('.');
  const fracPadded = (`${fracPart}00000000`).slice(0, 8);
  const halford = BigInt(intPart || '0') * HALFORD + BigInt(fracPadded || '0');
  return negative ? -halford : halford;
}

/**
 * Convert halford BigInt to a GRC string. Used at API boundaries so
 * JSON consumers can keep the full precision without the JSON-number
 * mantissa losing precision past ~15 digits.
 */
export function halford2grc(halford: bigint): string {
  const negative = halford < 0n;
  const abs = negative ? -halford : halford;
  const intPart = abs / HALFORD;
  const fracPart = abs % HALFORD;
  const fracStr = fracPart.toString().padStart(8, '0').replace(/0+$/, '');
  const formatted = fracStr.length === 0 ? `${intPart}` : `${intPart}.${fracStr}`;
  return negative ? `-${formatted}` : formatted;
}

/**
 * Sum a list of halford BigInts. Convenience helper.
 */
export function sumHalford(values: bigint[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + v, 0n);
}
