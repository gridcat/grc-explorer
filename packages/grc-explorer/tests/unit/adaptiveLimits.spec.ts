import {
  describe, it, expect, vi,
} from 'vitest';
import { createAdaptiveLimitsForTest } from '../../src/services/indexer/AdaptiveLimits';

describe('AdaptiveLimits', () => {
  it('starts at the configured maximums', () => {
    const limits = createAdaptiveLimitsForTest({ maxConcurrency: 8, maxFetchSpan: 25 });
    expect(limits.getConcurrency()).toBe(8);
    expect(limits.getFetchSpan()).toBe(25);
    expect(limits.isQuiet()).toBe(false);
  });

  it('halves both knobs on stress, floored at the configured minimums', () => {
    const limits = createAdaptiveLimitsForTest({
      minConcurrency: 1,
      maxConcurrency: 8,
      minFetchSpan: 1,
      maxFetchSpan: 16,
    });

    limits.onStress('test');
    expect(limits.getConcurrency()).toBe(4);
    expect(limits.getFetchSpan()).toBe(8);

    limits.onStress('test');
    expect(limits.getConcurrency()).toBe(2);
    expect(limits.getFetchSpan()).toBe(4);

    limits.onStress('test');
    expect(limits.getConcurrency()).toBe(1);
    expect(limits.getFetchSpan()).toBe(2);

    // At floor; further stress can't go lower.
    limits.onStress('test');
    limits.onStress('test');
    expect(limits.getConcurrency()).toBe(1);
    expect(limits.getFetchSpan()).toBe(1);
  });

  it('debounces rapid stress signals so a single burst is one halving', () => {
    const limits = createAdaptiveLimitsForTest({
      maxConcurrency: 8,
      maxFetchSpan: 25,
      stressDebounceMs: 60_000,
    });

    limits.onStress('first');
    limits.onStress('within-debounce');
    limits.onStress('within-debounce');
    limits.onStress('within-debounce');

    expect(limits.getConcurrency()).toBe(4);
    expect(limits.getFetchSpan()).toBe(12);
  });

  it('arms a quiet period after stress', () => {
    const limits = createAdaptiveLimitsForTest({ stressQuietMs: 60_000 });

    expect(limits.isQuiet()).toBe(false);
    limits.onStress('test');
    expect(limits.isQuiet()).toBe(true);
    expect(limits.quietRemainingMs()).toBeGreaterThan(50_000);
    expect(limits.quietRemainingMs()).toBeLessThanOrEqual(60_000);
  });

  it('quiet period elapses on its own', () => {
    vi.useFakeTimers();
    const limits = createAdaptiveLimitsForTest({ stressQuietMs: 1000 });
    limits.onStress('test');
    expect(limits.isQuiet()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(limits.isQuiet()).toBe(false);
    vi.useRealTimers();
  });

  it('ramps concurrency back +1 per rampThreshold successes, before span', () => {
    const limits = createAdaptiveLimitsForTest({
      minConcurrency: 1,
      maxConcurrency: 4,
      minFetchSpan: 1,
      maxFetchSpan: 8,
      rampThreshold: 3,
    });

    // Halve down to floor.
    limits.onStress('test');
    limits.onStress('test');
    limits.onStress('test');
    expect(limits.getConcurrency()).toBe(1);
    expect(limits.getFetchSpan()).toBe(1);

    // Three successes → +1 concurrency.
    limits.onSuccess();
    limits.onSuccess();
    expect(limits.getConcurrency()).toBe(1);
    limits.onSuccess();
    expect(limits.getConcurrency()).toBe(2);
    expect(limits.getFetchSpan()).toBe(1);

    // Continue ramping concurrency until at max before touching span.
    for (let i = 0; i < 6; i += 1) limits.onSuccess();
    expect(limits.getConcurrency()).toBe(4);
    expect(limits.getFetchSpan()).toBe(1);

    // Now successes start growing span.
    for (let i = 0; i < 3; i += 1) limits.onSuccess();
    expect(limits.getConcurrency()).toBe(4);
    expect(limits.getFetchSpan()).toBeGreaterThan(1);
  });

  it('a stress event resets the success streak', () => {
    const limits = createAdaptiveLimitsForTest({
      minConcurrency: 1,
      maxConcurrency: 4,
      maxFetchSpan: 8,
      rampThreshold: 5,
    });

    limits.onStress('test');
    limits.onSuccess();
    limits.onSuccess();
    limits.onSuccess();
    expect(limits.snapshot().successStreak).toBe(3);
    limits.onStress('test'); // stress wipes the streak
    expect(limits.snapshot().successStreak).toBe(0);
  });

  it('successes are no-ops once at max', () => {
    const limits = createAdaptiveLimitsForTest({
      minConcurrency: 1,
      maxConcurrency: 2,
      minFetchSpan: 1,
      maxFetchSpan: 2,
      rampThreshold: 1,
    });

    expect(limits.getConcurrency()).toBe(2);
    expect(limits.getFetchSpan()).toBe(2);
    for (let i = 0; i < 10; i += 1) limits.onSuccess();
    expect(limits.getConcurrency()).toBe(2);
    expect(limits.getFetchSpan()).toBe(2);
    expect(limits.snapshot().successStreak).toBe(0);
  });
});
