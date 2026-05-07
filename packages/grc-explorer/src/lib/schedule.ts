import { log } from './log';
import { isWipeInProgress } from './redis';

/**
 * Single-flight `setInterval`. If the previous tick is still running
 * when the timer fires, the new tick is skipped — preventing
 * overlapping cycles when an indexer pass takes longer than one
 * interval (which it routinely does during catch-up).
 *
 * Also skips ticks while a wipe is in progress (see `setWipeLock` in
 * lib/redis.ts). The wipe script flips this flag, waits for the
 * cursor to stop moving, then drops the DB — gating ticks here keeps
 * the indexer from racing the wipe and writing post-genesis rows
 * into a freshly-empty schema.
 *
 * Mirrors the `schedule()` helper in grcpay's index.ts but keeps the
 * label optional so callers don't have to invent names for every
 * loop. Returns a stop function.
 */
export function schedule(
  intervalMs: number,
  fn: () => Promise<void> | void,
  label?: string,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    try {
      if (await isWipeInProgress()) return;
    } catch (err) {
      // Redis flake during the lock check shouldn't drop a tick — log
      // and proceed on the assumption that no wipe is happening (the
      // wipe path itself depends on Redis being healthy).
      log.warn(`schedule(${label ?? 'anonymous'}) wipe-lock check failed`, err);
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error(`schedule(${label ?? 'anonymous'}) tick threw`, err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  // First tick fires on next microtask so the caller can wire dependent
  // services before any work happens.
  setImmediate(tick);
  return () => clearInterval(handle);
}
