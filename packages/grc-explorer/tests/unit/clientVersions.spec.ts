import { describe, it, expect } from 'vitest';
import {
  normalizeClientVersion, rollupClientVersions, OTHER_VERSION, DailyVersionRow,
} from '../../src/lib/clientVersions';

describe('normalizeClientVersion', () => {
  it('strips a leading v and a git/build suffix', () => {
    expect(normalizeClientVersion('v5.3.2.0-gfe6ab878a')).toBe('5.3.2.0');
    expect(normalizeClientVersion('v5.3.2.0-unk')).toBe('5.3.2.0');
    expect(normalizeClientVersion('v5.4.0.0')).toBe('5.4.0.0');
  });

  it('accepts a version with no leading v (collapses with the v form)', () => {
    expect(normalizeClientVersion('5.4.5.0')).toBe('5.4.5.0');
    expect(normalizeClientVersion('v5.4.5.0')).toBe('5.4.5.0');
  });

  it('accepts 2- and 3-component versions', () => {
    expect(normalizeClientVersion('5.5')).toBe('5.5');
    expect(normalizeClientVersion('v5.5.1')).toBe('5.5.1');
  });

  it('folds empty/garbage into other', () => {
    expect(normalizeClientVersion('')).toBe(OTHER_VERSION);
    expect(normalizeClientVersion(null)).toBe(OTHER_VERSION);
    expect(normalizeClientVersion(undefined)).toBe(OTHER_VERSION);
    expect(normalizeClientVersion('not-a-version')).toBe(OTHER_VERSION);
    expect(normalizeClientVersion('v')).toBe(OTHER_VERSION);
  });
});

describe('rollupClientVersions', () => {
  const row = (ts: number, raw: string, blocks: number): DailyVersionRow => ({
    ts, date: new Date(ts * 1000).toISOString().slice(0, 10), raw_version: raw, blocks,
  });

  it('collapses raw variants of the same release into one series', () => {
    const { versions, points } = rollupClientVersions([
      row(100, 'v5.3.2.0-gfe6ab878a', 3),
      row(100, '5.3.2.0', 2),
    ]);
    expect(versions).toEqual(['5.3.2.0']);
    expect(points).toHaveLength(1);
    expect(points[0].counts['5.3.2.0']).toBe(5);
    expect(points[0].total).toBe(5);
  });

  it('selects by total blocks but orders the output by version number, newest first', () => {
    // 3.5.8.8 has the biggest lifetime total, but the legend is sorted by
    // version number, not footprint.
    const { versions } = rollupClientVersions([
      row(100, 'v3.5.8.8', 1000),
      row(100, 'v5.4.0.0', 10),
      row(200, 'v5.5.1.0', 50),
    ]);
    expect(versions).toEqual(['5.5.1.0', '5.4.0.0', '3.5.8.8']);
  });

  it('keeps only the top-N by total, but still counts the rest in the day total', () => {
    const rows: DailyVersionRow[] = [
      row(100, 'v5.5.0.0', 100),
      row(100, 'v5.4.0.0', 50),
      row(100, 'v3.0.0.0', 5), // outside top-2 → not a series, but still in total
    ];
    const { versions, points } = rollupClientVersions(rows, 2);
    expect(versions).toEqual(['5.5.0.0', '5.4.0.0']);
    expect(points[0].counts['3.0.0.0']).toBeUndefined();
    expect(points[0].total).toBe(155);
  });

  it('always shows the current release (recent-dominant) even with a tiny lifetime total', () => {
    const DAY = 86_400;
    // 5.4.0.0 dominates years of history (huge total); 5.5.1.0 is days old
    // with a tiny total but dominates the latest day. top-1-by-total would
    // pick only 5.4.0.0 — the recency guarantee must still surface 5.5.1.0.
    const rows: DailyVersionRow[] = [];
    for (let d = 1; d <= 300; d += 1) rows.push(row(d * DAY, 'v5.4.0.0', 100));
    rows.push(row(301 * DAY, 'v5.5.1.0', 5)); // latest day, dominant
    const { versions } = rollupClientVersions(rows, 1);
    expect(versions).toContain('5.5.1.0');
    expect(versions).toContain('5.4.0.0');
  });

  it('never emits an other series but folds garbage into the day total', () => {
    const { versions, points } = rollupClientVersions([
      row(100, 'v5.5.0.0', 90),
      row(100, 'not-a-version', 10),
    ]);
    expect(versions).toEqual(['5.5.0.0']);
    expect(points[0].counts[OTHER_VERSION]).toBeUndefined();
    expect(points[0].total).toBe(100); // garbage still counted for honest shares
  });

  it('buckets per day, points sorted ascending, total is the full day total', () => {
    const { points } = rollupClientVersions([
      row(200, 'v5.5.0.0', 2),
      row(100, 'v5.5.0.0', 1),
      row(100, 'v5.4.0.0', 4),
    ]);
    expect(points.map((p) => p.ts)).toEqual([100, 200]);
    expect(points[0].total).toBe(5);
    expect(points[0].counts['5.4.0.0']).toBe(4);
    expect(points[0].counts['5.5.0.0']).toBe(1);
    expect(points[1].counts['5.5.0.0']).toBe(2);
  });

  it('returns empty series for no rows', () => {
    expect(rollupClientVersions([])).toEqual({ versions: [], points: [] });
  });
});
