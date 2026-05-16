import {
  formatCompact, formatDuration, formatGrc, formatGrcCompact, shortHash,
} from '../src/lib/format';

describe('formatGrc', () => {
  it('renders null/undefined as the em-dash placeholder', () => {
    expect(formatGrc(null)).toBe('—');
    expect(formatGrc(undefined)).toBe('—');
  });

  it('returns NaN-input verbatim instead of "NaN"', () => {
    expect(formatGrc('not-a-number')).toBe('not-a-number');
  });

  it('preserves up to 8 fractional digits without float drift', () => {
    // backend ships halford strings; the formatter shouldn't lose
    // precision when the value reaches the UI as text
    expect(formatGrc('1.23456789')).toMatch(/^1[.,]23456789$/);
  });
});

describe('formatCompact scientific branch', () => {
  it('renders 1.3e+64 as mantissa·10⁶⁴ with Unicode superscripts', () => {
    expect(formatCompact(1.3e64)).toBe('1.3·10⁶⁴');
  });

  it('drops a unit mantissa (renders 10⁶⁴ rather than 1.0·10⁶⁴)', () => {
    expect(formatCompact(1e64)).toBe('10⁶⁴');
  });

  it('falls back to scientific only below 1e-9', () => {
    expect(formatCompact(1.7e-12)).toBe('1.7·10⁻¹²');
  });

  it('preserves sign on negatives', () => {
    expect(formatCompact(-1.3e64)).toBe('-1.3·10⁶⁴');
  });
});

describe('formatCompact sub-1 decimal branch', () => {
  it('renders 0.00024 as a literal decimal, not scientific', () => {
    expect(formatCompact(0.00024)).toBe('0.00024');
  });

  it('trims trailing zeros from 0.001 → "0.001"', () => {
    expect(formatCompact(0.001)).toBe('0.001');
  });

  it('renders 0.5 without padding ("0.5", not "0.50")', () => {
    expect(formatCompact(0.5)).toBe('0.5');
  });

  it('keeps two significant figures across the sub-1 range', () => {
    expect(formatCompact(0.012345)).toBe('0.012');
  });
});

describe('formatGrcCompact', () => {
  it('falls back to "0" for zero or non-finite inputs', () => {
    expect(formatGrcCompact(0)).toBe('0');
    expect(formatGrcCompact(NaN)).toBe('0');
    expect(formatGrcCompact(Infinity)).toBe('0');
  });

  it('uses M / K suffixes for large numbers', () => {
    expect(formatGrcCompact(1_500_000)).toMatch(/M$/);
    expect(formatGrcCompact(2_500)).toMatch(/K$/);
  });

  it('leaves sub-thousand values without a suffix', () => {
    expect(formatGrcCompact(42)).not.toMatch(/[KM]/);
  });
});

describe('shortHash', () => {
  it('shortens long hex strings with a separator', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const out = shortHash(hash);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(hash.length);
  });

  it('returns the input unchanged when it already fits', () => {
    expect(shortHash('abcdef', 10, 6)).toBe('abcdef');
  });
});

describe('formatDuration', () => {
  it('selects a single unit by magnitude', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(7_200)).toBe('2h');
    expect(formatDuration(86_400 * 3)).toBe('3d');
    expect(formatDuration(86_400 * 14)).toBe('2w');
    expect(formatDuration(86_400 * 90)).toBe('3mo');
    expect(formatDuration(86_400 * 365 * 4)).toBe('4y');
  });

  it('clamps negative inputs to zero rather than emitting "-Ns"', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});
