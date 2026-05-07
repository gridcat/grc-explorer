import { grc2halford, halford2grc, sumHalford } from '../../src/lib/halford';

describe('halford conversions', () => {
  it('round-trips integer GRC values exactly', () => {
    expect(halford2grc(grc2halford('1'))).toBe('1');
    expect(halford2grc(grc2halford('1234567'))).toBe('1234567');
  });

  it('preserves the full 8 decimal digits without float drift', () => {
    expect(grc2halford('0.00000001')).toBe(1n);
    expect(grc2halford('1.23456789')).toBe(123456789n);
    expect(halford2grc(123456789n)).toBe('1.23456789');
  });

  it('handles negative amounts (e.g. address deltas in reorg rollback)', () => {
    expect(grc2halford('-2.5')).toBe(-250000000n);
    expect(halford2grc(-250000000n)).toBe('-2.5');
  });

  it('strips trailing zeros in the fractional part', () => {
    expect(halford2grc(150000000n)).toBe('1.5');
    expect(halford2grc(100000000n)).toBe('1');
  });

  it('sums BigInts without precision loss', () => {
    expect(sumHalford([1n, 2n, 3n])).toBe(6n);
    expect(sumHalford([])).toBe(0n);
  });
});
