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

// Circuit breaker for the Gridcoin RPC client. Wraps the per-call timeout
// with a failure-rate gate so the explorer stops hammering a daemon
// that's clearly in trouble, giving it room to recover.
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

class BreakerOpenError extends Error {
  public readonly code = 'RPC_BREAKER_OPEN';

  constructor(method: string, openedForMs: number) {
    super(
      `Gridcoin RPC breaker is open after ${config.RPC_BREAKER_THRESHOLD} consecutive failures; `
      + `rejecting ${method} (cooldown resumes in ~${Math.max(0, Math.ceil(openedForMs / 1000))}s)`,
    );
  }
}

class RpcBreaker {
  private state: BreakerState = 'closed';

  private consecutiveFailures = 0;

  private openedAt = 0;

  public isDisabled(): boolean {
    return config.RPC_BREAKER_THRESHOLD <= 0;
  }

  public precheck(method: string): void {
    if (this.isDisabled()) return;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < config.RPC_BREAKER_COOLDOWN_MS) {
        throw new BreakerOpenError(method, config.RPC_BREAKER_COOLDOWN_MS - elapsed);
      }
      this.state = 'half-open';
      log.info('Gridcoin RPC breaker transitioning from open → half-open (probing)');
    }
  }

  public recordSuccess(): void {
    if (this.isDisabled()) return;
    if (this.state !== 'closed') {
      log.info(`Gridcoin RPC breaker transitioning from ${this.state} → closed`);
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
        `Gridcoin RPC breaker tripping open after ${this.consecutiveFailures} failures; `
        + `cooldown ${config.RPC_BREAKER_COOLDOWN_MS}ms`,
      );
    }
    this.state = 'open';
    this.openedAt = Date.now();
  }
}

const breaker = new RpcBreaker();

const rawRpc = new GridcoinRPC({
  port: config.GRC_RPC_PORT,
  host: config.GRC_RPC_HOST,
  username: config.GRC_RPC_USER,
  password: config.GRC_RPC_PASSWORD,
});

// Proxy every method call through the timeout + breaker layers. Callers
// just `await rpc.getBlock(...)`; the resilience behaviour is invisible
// except in the error types they might see (BreakerOpenError, "... timed
// out after Nms").
export const rpc = new Proxy(rawRpc, {
  get(target, prop: string | symbol, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function') return value;
    return function wrapped(this: unknown, ...args: unknown[]) {
      const method = String(prop);
      try {
        breaker.precheck(method);
      } catch (e) {
        return Promise.reject(e);
      }
      const result = value.apply(this === receiver ? target : this, args);
      if (!result || typeof (result as Promise<unknown>).then !== 'function') {
        return result;
      }
      return withTimeout(result as Promise<unknown>, method)
        .then((ok) => {
          breaker.recordSuccess();
          return ok;
        })
        .catch((err) => {
          breaker.recordFailure();
          throw err;
        });
    };
  },
}) as typeof rawRpc;

// Block until the wallet daemon answers a basic health check. Used at
// boot so we don't crash-loop the container before the daemon's done
// loading the blockchain.
export async function connect(): Promise<boolean> {
  try {
    await (rpc as unknown as { getBlockchainInfo: () => Promise<unknown> }).getBlockchainInfo();
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
