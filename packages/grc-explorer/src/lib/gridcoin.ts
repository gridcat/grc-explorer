/* eslint-disable max-classes-per-file */
import { GridcoinRPC } from 'gridcoin-rpc';
import { config } from '../config';
import { log } from './log';

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

  constructor(private readonly lane: Lane) {}

  public isDisabled(): boolean {
    return config.RPC_BREAKER_THRESHOLD <= 0;
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
function makeProxy(breaker: RpcBreaker, semaphore?: Semaphore): typeof rawRpc {
  return new Proxy(rawRpc, {
    get(target, prop: string | symbol, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(...args: unknown[]) {
        const method = String(prop);
        try {
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
            return ok;
          })
          .catch((err) => {
            breaker.recordFailure();
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
// dispatcher level. Their breaker only counts live failures.
export const liveRpc = makeProxy(liveBreaker);

// `heavyRpc` — long batched calls used by HistoricalBackfiller
// (`getBlocksBatch`). Its semaphore enforces the concurrency cap
// previously implicit in `processRange`'s `inFlight < concurrency`
// math; failures are isolated in their own breaker so a stalled
// backfill doesn't open a shared breaker that takes mempool / tip
// observability down with it.
export const heavyRpc = makeProxy(heavyBreaker, heavySemaphore);

// Block until the wallet daemon answers a basic health check. Used at
// boot so we don't crash-loop the container before the daemon's done
// loading the blockchain.
export async function connect(): Promise<boolean> {
  try {
    await (liveRpc as unknown as { getBlockchainInfo: () => Promise<unknown> }).getBlockchainInfo();
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
