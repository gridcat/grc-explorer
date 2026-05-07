import { toBigInt } from '../../src/services/jobs/PollWeightAggregator';

// `toBigInt` is the coercion helper that bridges between MySQL's
// `SUM(BIGINT) -> DECIMAL` (which Prisma surfaces as `Prisma.Decimal`)
// and our schema's BigInt columns. Bug it was added to fix:
// PrismaClientValidationError on `polls.av_w_balance` because the
// raw query returned a Decimal-shaped object.

describe('toBigInt', () => {
  it('passes bigints through unchanged', () => {
    expect(toBigInt(1234567890123456789n)).toBe(1234567890123456789n);
  });

  it('truncates fractional digits coming back as a Decimal-like string', () => {
    // Prisma.Decimal.toString() form
    expect(toBigInt('123456789.5')).toBe(123456789n);
  });

  it('preserves precision for values larger than Number.MAX_SAFE_INTEGER', () => {
    const huge = '99999999999999999999';
    expect(toBigInt(huge)).toBe(99999999999999999999n);
  });

  it('handles plain numbers via Math.trunc', () => {
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(42.9)).toBe(42n);
  });

  it('returns 0n for null / undefined / empty inputs', () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt('')).toBe(0n);
  });

  it('coerces objects via their string serialization (Prisma.Decimal etc.)', () => {
    const decimalLike = { toString: () => '987654321' };
    expect(toBigInt(decimalLike)).toBe(987654321n);
  });
});
