/* eslint-disable max-classes-per-file */
import { GridcoinRPC } from 'gridcoin-rpc';
import { config } from '../config';
import { log } from './log';
import { adaptiveLimits } from '../services/indexer/AdaptiveLimits';

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

// Per-call timeout. gridcoin-rpc wraps Node's http.request with no
// timeout option, so a misbehaving daemon can wedge a call indefinitely
// — which in turn wedges every job loop that awaits inline. Default 30s
// is long enough for a slow getblock-verbose-2 on a busy chain, short
// enough that one stuck call can't keep an indexer tick frozen.
async function withTimeout<T>(p: Promise<T>, method: string, ms = config.RPC_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Gridcoin RPC ${method} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// FIFO semaphore. Heavy RPC traffic (the backfill `getblocksbatch`
// pump) goes through one of these so its in-flight count is centrally
// enforced regardless of how many callers happen to be issuing heavy
// calls. Live traffic bypasses it entirely — small calls should never
// queue behind a heavy batch at the dispatcher level.
//
// Invariant: `waiters[]` stays bounded only because every current
// heavy-lane caller (HistoricalBackfiller.processRange) already self-
// gates to the same `BACKFILL_CONCURRENCY` cap. The semaphore is the
// dispatcher-level safety net for any future caller that forgets to.
class Semaphore {
  private available: number;

  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = Math.max(0, capacity);
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Circuit breaker for the Gridcoin RPC client. Wraps the per-call
// timeout with a failure-rate gate so the explorer stops hammering a
// daemon that's clearly in trouble, giving it room to recover. Each
// proxy lane (live, heavy) owns its own breaker so a stalled backfill
// doesn't take live mempool/tip observability down with it.
//
// States:
//   closed    — normal. Failures increment; successes reset.
//   open      — fast-fail. Cooldown timer runs in the background; when
//               it elapses the next request transitions us to half-open.
//   half-open — probe. One request is allowed through. Success closes;
//               failure goes straight back to open with a fresh cooldown.
//
// Disabled by RPC_BREAKER_THRESHOLD=0.
type BreakerState = 'closed' | 'open' | 'half-open';
type Lane = 'live' | 'heavy';

class BreakerOpenError extends Error {
  public readonly code = 'RPC_BREAKER_OPEN';

  public readonly lane: Lane;

  constructor(lane: Lane, method: string, openedForMs: number) {
    super(
      `Gridcoin RPC breaker [${lane}] is open after ${config.RPC_BREAKER_THRESHOLD} consecutive failures; `
      + `rejecting ${method} (cooldown resumes in ~${Math.max(0, Math.ceil(openedForMs / 1000))}s)`,
    );
    this.lane = lane;
  }
}

class RpcBreaker {
  private state: BreakerState = 'closed';

  private consecutiveFailures = 0;

  private openedAt = 0;

  constructor(public readonly lane: Lane) {}

  public isDisabled(): boolean {
    return config.RPC_BREAKER_THRESHOLD <= 0;
  }

  // True iff the breaker is currently in `open` state and still
  // within its cooldown window. Lets one breaker gate calls on
  // another lane's health (heavy refuses while live is open — a
  // failing live lane is the daemon telling us it can't even
  // answer cheap calls, so adding heavy on top would just stack
  // work it can't drain).
  public isOpen(): boolean {
    if (this.isDisabled()) return false;
    if (this.state !== 'open') return false;
    return Date.now() - this.openedAt < config.RPC_BREAKER_COOLDOWN_MS;
  }

  public cooldownRemainingMs(): number {
    if (!this.isOpen()) return 0;
    return Math.max(0, config.RPC_BREAKER_COOLDOWN_MS - (Date.now() - this.openedAt));
  }

  public precheck(method: string): void {
    if (this.isDisabled()) return;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < config.RPC_BREAKER_COOLDOWN_MS) {
        throw new BreakerOpenError(this.lane, method, config.RPC_BREAKER_COOLDOWN_MS - elapsed);
      }
      this.state = 'half-open';
      log.info(`Gridcoin RPC breaker [${this.lane}] transitioning from open → half-open (probing)`);
    }
  }

  public recordSuccess(): void {
    if (this.isDisabled()) return;
    if (this.state !== 'closed') {
      log.info(`Gridcoin RPC breaker [${this.lane}] transitioning from ${this.state} → closed`);
    }
    this.state = 'closed';
    this.consecutiveFailures = 0;
  }

  public recordFailure(): void {
    if (this.isDisabled()) return;
    if (this.state === 'half-open') {
      this.trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= config.RPC_BREAKER_THRESHOLD) {
      this.trip();
    }
  }

  private trip(): void {
    if (this.state !== 'open') {
      log.warn(
        `Gridcoin RPC breaker [${this.lane}] tripping open after ${this.consecutiveFailures} failures; `
        + `cooldown ${config.RPC_BREAKER_COOLDOWN_MS}ms`,
      );
    }
    this.state = 'open';
    this.openedAt = Date.now();
  }
}

const liveBreaker = new RpcBreaker('live');
const heavyBreaker = new RpcBreaker('heavy');
const heavySemaphore = new Semaphore(config.BACKFILL_CONCURRENCY);

const rawRpc = new GridcoinRPC({
  port: config.GRC_RPC_PORT,
  host: config.GRC_RPC_HOST,
  username: config.GRC_RPC_USER,
  password: config.GRC_RPC_PASSWORD,
});

// Wrap every method on the underlying client with breaker + timeout
// (and, for the heavy lane, a semaphore that bounds concurrent
// in-flight calls). Callers just `await liveRpc.getBlock(...)` /
// `await heavyRpc.getBlocksBatch(...)`; resilience is invisible
// except in the error types they might see (BreakerOpenError, "...
// timed out after Nms").
//
// `dependsOn` lets one lane refuse work while another lane is
// failing. The heavy lane passes `liveBreaker` here: if cheap calls
// (mempool poll, tip height) are already timing out, the daemon is
// stressed and stacking more `getblocksbatch` work on top would
// just queue requests it can't drain.
//
// `feedsAdaptive` controls whether successes and failures on this
// proxy feed the AdaptiveLimits AIMD controller. The heavy proxy
// uses this directly (its successes ramp limits up, its failures
// halve them). The live proxy also signals stress on failure so
// that timeout cascades on cheap calls trigger the same drain
// behaviour — but we don't ramp on live successes, since cheap
// calls succeeding doesn't tell us whether heavy load is safe yet.
type AdaptiveSignal = 'none' | 'stress-only' | 'both';

function makeProxy(
  breaker: RpcBreaker,
  semaphore?: Semaphore,
  dependsOn?: RpcBreaker,
  adaptiveSignal: AdaptiveSignal = 'none',
): typeof rawRpc {
  return new Proxy(rawRpc, {
    get(target, prop: string | symbol, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(...args: unknown[]) {
        const method = String(prop);
        try {
          if (dependsOn && dependsOn.isOpen()) {
            throw new BreakerOpenError(
              breaker.lane,
              method,
              dependsOn.cooldownRemainingMs(),
            );
          }
          // Heavy lane refuses while AIMD is in its post-stress
          // quiet window — the daemon needs that gap to drain its
          // queue. The error reuses BreakerOpenError so callers
          // (schedule.ts, HistoricalBackfiller) handle it the same
          // way they handle a tripped breaker.
          if (adaptiveSignal === 'both' && adaptiveLimits.isQuiet()) {
            throw new BreakerOpenError(
              breaker.lane,
              method,
              adaptiveLimits.quietRemainingMs(),
            );
          }
          breaker.precheck(method);
        } catch (e) {
          return Promise.reject(e);
        }
        // Every gridcoin-rpc method funnels through RPCBase.call,
        // which is async — the proxied invocation always returns a
        // Promise. No non-Promise branch needed.
        const issue = () => withTimeout(
          value.apply(target, args) as Promise<unknown>,
          method,
        )
          .then((ok) => {
            breaker.recordSuccess();
            if (adaptiveSignal === 'both') adaptiveLimits.onSuccess();
            return ok;
          })
          .catch((err) => {
            breaker.recordFailure();
            if (adaptiveSignal !== 'none') {
              adaptiveLimits.onStress(`${breaker.lane}:${method}`);
            }
            throw err;
          });
        return semaphore ? semaphore.run(issue) : issue();
      };
    },
  }) as typeof rawRpc;
}

// `liveRpc` — small, frequent calls (mempool poll, tip height,
// network stats, single-tx route fetches). No semaphore: live calls
// must never queue behind in-flight backfill batches at the
// dispatcher level. Their breaker only counts live failures, but
// live failures DO feed AdaptiveLimits as a stress signal — a
// cheap call timing out is a strong "daemon is overloaded" signal.
// Live successes do NOT ramp adaptive limits; cheap calls
// succeeding tells us nothing about heavy capacity.
export const liveRpc = makeProxy(liveBreaker, undefined, undefined, 'stress-only');

// `heavyRpc` — long batched calls used by HistoricalBackfiller
// (`getBlocksBatch`). Three layers of resilience stack here:
//
//   1. Heavy semaphore caps concurrent in-flight calls (safety net
//      sized to the configured maximum).
//   2. `dependsOn=liveBreaker` refuses heavy issuance while the
//      live lane is in trouble — daemon can't even answer cheap
//      calls, no point asking it for blocks.
//   3. AdaptiveLimits AIMD: heavy successes ramp the effective
//      concurrency + fetch span back up, heavy failures halve them
//      and arm a quiet period during which heavy refuses outright.
//      The backfiller pump reads `adaptiveLimits.getConcurrency()`
//      and `getFetchSpan()` per pump step, so old in-flight calls
//      drain naturally and new pump iterations honor the new limits.
export const heavyRpc = makeProxy(heavyBreaker, heavySemaphore, liveBreaker, 'both');

// `simpleRpc` — bare wrapper used by the sequential backfill mode
// (BACKFILL_SEQUENTIAL=true). Only the per-call timeout + breaker
// remain; no semaphore, no live-lane dependency, no AIMD signals.
// Sequential mode does one block at a time and commits each one
// before the next call, so the only safety net it needs is the
// breaker's "5 timeouts in a row → 30s cooldown" backstop. Shares
// the heavyBreaker instance so a tripped breaker pauses both modes
// — they don't run concurrently anyway.
export const simpleRpc = makeProxy(heavyBreaker);

// Block until the wallet daemon answers a basic health check. Used at
// boot so we don't crash-loop the container before the daemon's done
// loading the blockchain.
export async function connect(): Promise<boolean> {
  try {
    await liveRpc.getBlockchainInfo();
    return true;
  } catch (_err) {
    log.warn('Gridcoin RPC connection error — retrying');
    await wait(5000);
    return false;
  }
}

export async function waitForRpc(): Promise<void> {
  /* eslint-disable no-await-in-loop */
  while (!(await connect())) {
    // retry indefinitely; each connect() already waits 5s on failure
  }
  /* eslint-enable no-await-in-loop */
  log.info('Gridcoin RPC daemon reachable');
}
