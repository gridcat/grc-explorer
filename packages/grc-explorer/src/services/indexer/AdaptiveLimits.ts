import { config } from '../../config';
import { log } from '../../lib/log';

// AIMD-style adaptive controller for the heavy-lane backfill knobs.
// Three pieces of state:
//
//   - effective concurrency: how many `getblocksbatch` RPCs the
//     backfiller's pump may have in flight.
//   - effective fetch span: how many blocks each batch asks for.
//   - quiet-until timestamp: a hard "no heavy calls allowed"
//     window applied after a stress event so the daemon's RPC
//     queue can drain whatever it's already working on. We can't
//     abort the daemon's in-flight work from the client; the
//     only honest backpressure is "stop pestering it for a while".
//
// On a stress signal (live breaker tripping or a heavy call
// failing), both knobs halve toward their configured floor AND a
// quiet period starts. On a run of `RAMP_THRESHOLD` consecutive
// heavy successes, concurrency climbs +1 per step until it hits
// the ceiling, then span starts growing back. Stress signals are
// debounced — a single failure burst is one halving, not five —
// so a brief daemon hiccup doesn't collapse us to the floor.
//
// Same shape as TCP congestion control: ramp up cautiously, back
// off hard, with an explicit drain window after each backoff.
class AdaptiveLimits {
  private concurrency: number;

  private fetchSpan: number;

  private successStreak = 0;

  private lastStressAt = 0;

  private quietUntil = 0;

  constructor(
    public readonly minConcurrency: number,
    public readonly maxConcurrency: number,
    public readonly minFetchSpan: number,
    public readonly maxFetchSpan: number,
    public readonly rampThreshold: number,
    public readonly stressDebounceMs: number,
    public readonly stressQuietMs: number,
  ) {
    this.concurrency = maxConcurrency;
    this.fetchSpan = maxFetchSpan;
  }

  public getConcurrency(): number {
    return this.concurrency;
  }

  public getFetchSpan(): number {
    return this.fetchSpan;
  }

  // True iff a stress event recently fired and the drain window
  // hasn't elapsed yet. Heavy callers should refuse to issue while
  // this is true.
  public isQuiet(): boolean {
    return Date.now() < this.quietUntil;
  }

  public quietRemainingMs(): number {
    return Math.max(0, this.quietUntil - Date.now());
  }

  // Daemon-stress signal. Halves both knobs toward their floors
  // and arms the quiet period so the daemon can drain. Multiple
  // calls inside `stressDebounceMs` collapse into a single halving
  // (so a burst of timeouts doesn't drive us straight to min on
  // one incident), but each call still extends the quiet window.
  public onStress(reason: string): void {
    const now = Date.now();
    // Always extend the quiet window — a fresh stress signal means
    // the daemon is still under load even if we already halved.
    this.quietUntil = Math.max(this.quietUntil, now + this.stressQuietMs);

    if (now - this.lastStressAt < this.stressDebounceMs) {
      this.successStreak = 0;
      return;
    }
    this.lastStressAt = now;

    const prevConcurrency = this.concurrency;
    const prevSpan = this.fetchSpan;
    this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
    this.fetchSpan = Math.max(this.minFetchSpan, Math.floor(this.fetchSpan / 2));
    this.successStreak = 0;

    if (prevConcurrency !== this.concurrency || prevSpan !== this.fetchSpan) {
      log.warn(
        `Adaptive backfill: stress (${reason}); concurrency ${prevConcurrency}→${this.concurrency}, span ${prevSpan}→${this.fetchSpan}, quiet ${this.stressQuietMs}ms`,
      );
    } else {
      log.info(
        `Adaptive backfill: stress (${reason}); already at floor (concurrency=${this.concurrency}, span=${this.fetchSpan}), quiet ${this.stressQuietMs}ms`,
      );
    }
  }

  // Heavy-call success signal. Increments the success streak; once
  // the streak hits `rampThreshold`, bumps one dimension up by a
  // step and resets the streak. Concurrency recovers before span —
  // pipeline width is the lower-risk dimension to restore first.
  public onSuccess(): void {
    if (
      this.concurrency >= this.maxConcurrency
      && this.fetchSpan >= this.maxFetchSpan
    ) {
      this.successStreak = 0;
      return;
    }

    this.successStreak += 1;
    if (this.successStreak < this.rampThreshold) return;
    this.successStreak = 0;

    const prevConcurrency = this.concurrency;
    const prevSpan = this.fetchSpan;
    if (this.concurrency < this.maxConcurrency) {
      this.concurrency += 1;
    } else if (this.fetchSpan < this.maxFetchSpan) {
      // Grow span by half its current value (rounded up to ≥1) so
      // recovery doesn't take forever once concurrency is restored.
      this.fetchSpan = Math.min(
        this.maxFetchSpan,
        this.fetchSpan + Math.max(1, Math.floor(this.fetchSpan / 2)),
      );
    }

    log.info(
      `Adaptive backfill: ramp; concurrency ${prevConcurrency}→${this.concurrency}, span ${prevSpan}→${this.fetchSpan}`,
    );
  }

  // Inspection hook for tests + future observability.
  public snapshot(): {
    concurrency: number;
    fetchSpan: number;
    successStreak: number;
    quietRemainingMs: number;
    } {
    return {
      concurrency: this.concurrency,
      fetchSpan: this.fetchSpan,
      successStreak: this.successStreak,
      quietRemainingMs: this.quietRemainingMs(),
    };
  }
}

export const adaptiveLimits = new AdaptiveLimits(
  config.BACKFILL_CONCURRENCY_MIN,
  config.BACKFILL_CONCURRENCY,
  config.BACKFILL_FETCH_SPAN_MIN,
  config.BACKFILL_FETCH_SPAN,
  config.BACKFILL_ADAPTIVE_RAMP_THRESHOLD,
  config.BACKFILL_ADAPTIVE_STRESS_DEBOUNCE_MS,
  config.BACKFILL_ADAPTIVE_STRESS_QUIET_MS,
);

// Test helper. Lets unit tests instantiate isolated controllers
// without sharing module-level state across cases.
export function createAdaptiveLimitsForTest(opts: {
  minConcurrency?: number;
  maxConcurrency?: number;
  minFetchSpan?: number;
  maxFetchSpan?: number;
  rampThreshold?: number;
  stressDebounceMs?: number;
  stressQuietMs?: number;
}): AdaptiveLimits {
  return new AdaptiveLimits(
    opts.minConcurrency ?? 1,
    opts.maxConcurrency ?? 8,
    opts.minFetchSpan ?? 1,
    opts.maxFetchSpan ?? 25,
    opts.rampThreshold ?? 5,
    opts.stressDebounceMs ?? 0,
    opts.stressQuietMs ?? 0,
  );
}
