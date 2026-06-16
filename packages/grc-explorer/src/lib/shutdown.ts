import { log } from './log';

// Process-wide graceful-shutdown coordinator. There was none before: a
// SIGTERM (docker compose restart/stop) was ignored until docker SIGKILLed
// the process ~10s later, which can land mid-write and corrupt DuckDB's
// on-disk state. And after a fatal DB invalidation, schedule() just kept
// ticking and re-throwing the same error forever. Both routes funnel here:
// stop the timers, let the in-flight tick finish, close DuckDB cleanly,
// then exit so the orchestrator restarts us.

type StopFn = () => void;
type CleanupFn = () => Promise<void> | void;

const stops = new Set<StopFn>();
const cleanups: CleanupFn[] = [];
const inflight = new Set<Promise<unknown>>();

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

// schedule() registers its clearInterval/clearTimeout here so a shutdown can
// stop every timer loop without the caller threading stop fns up to index.ts.
export function registerStop(fn: StopFn): void {
  stops.add(fn);
}

// Cleanup hooks run (in registration order) after timers are stopped and
// in-flight work has drained — DuckDB close, Redis quit, HTTP server close.
export function onShutdown(fn: CleanupFn): void {
  cleanups.push(fn);
}

// Track an in-flight async unit (a scheduled tick) so a shutdown waits for
// it to finish before tearing down the connections it depends on. The
// promise removes itself once settled.
export function trackInflight<T>(promise: Promise<T>): Promise<T> {
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
  return promise;
}

// Upper bound on how long we wait for in-flight ticks before forcing the
// teardown — a wedged tick must not block the restart indefinitely.
const DRAIN_TIMEOUT_MS = 15_000;

// Idempotent. Stops every timer, drains in-flight ticks (bounded), runs the
// cleanup hooks, then exits with `code`. code 0 for a signal-driven stop,
// non-zero for a fatal so the restart policy treats it as a crash and the
// boot self-heal kicks in.
export async function requestShutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const emit = code === 0 ? log.info : log.error;
  emit(`Shutdown requested (${reason}); stopping ${stops.size} timers, draining ${inflight.size} in-flight tasks`);

  for (const stop of stops) {
    try {
      stop();
    } catch (err) {
      log.warn('shutdown: stop fn threw', err);
    }
  }

  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn(`shutdown: drain timed out after ${DRAIN_TIMEOUT_MS}ms; tearing down anyway`);
        resolve();
      }, DRAIN_TIMEOUT_MS);
      timeout.unref();
    }),
  ]);

  for (const cleanup of cleanups) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await cleanup();
    } catch (err) {
      log.warn('shutdown: cleanup hook threw', err);
    }
  }

  log.info(`Shutdown complete; exiting ${code}`);
  process.exit(code);
}

// Wire OS signals to a graceful (exit-0) shutdown. Called once from index.ts.
export function installSignalHandlers(): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void requestShutdown(signal, 0);
    });
  }
}
