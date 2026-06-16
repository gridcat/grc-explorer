import { tsToUnix } from '../../src/lib/time';

describe('tsToUnix', () => {
  // Regression: DuckDB read routes cast time columns with
  // `CAST(epoch(col) AS BIGINT)`, which the duckdb client returns as a
  // plain integer STRING of unix seconds. The old converter fed those to
  // `new Date(...)` (Invalid Date → null → presenter `?? 0`), so every
  // poll/beacon/mempool timestamp rendered as 1970-01-01.
  it('reads a BIGINT epoch string as unix seconds directly', () => {
    expect(tsToUnix('1494653328')).toBe(1494653328);
    expect(tsToUnix('0')).toBe(0);
    expect(tsToUnix('-1')).toBe(-1);
  });

  it('still Date-parses raw TIMESTAMP strings (SELECT * columns)', () => {
    // 'YYYY-MM-DD HH:MM:SS' is not a pure-integer string, so it falls
    // through to the Date path and yields a positive epoch.
    const got = tsToUnix('2017-05-13 05:28:48');
    expect(got).not.toBeNull();
    expect(got).toBeGreaterThan(0);
  });

  it('passes finite numbers through and rejects NaN', () => {
    expect(tsToUnix(1494653328)).toBe(1494653328);
    expect(tsToUnix(Number.NaN)).toBeNull();
  });

  it('maps null/undefined/empty/garbage to null', () => {
    expect(tsToUnix(null)).toBeNull();
    expect(tsToUnix(undefined)).toBeNull();
    expect(tsToUnix('')).toBeNull();
    expect(tsToUnix('not-a-date')).toBeNull();
  });
});
