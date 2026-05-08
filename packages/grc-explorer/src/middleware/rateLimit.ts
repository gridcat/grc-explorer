import { Request, Response, NextFunction } from 'express';
import HttpStatus from 'http-status-codes';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { config } from '../config';
import { ErrorModel } from '../lib/errors';
import { redis } from '../lib/redis';

// Redis-backed rate limiter (audit P0 #3). Replaces the previous
// per-process Map<string, number[]> which was unbounded (IPv6 /128
// flood → OOM), per-process (multi-replica = N× allowance), and had
// no global RPS ceiling.
//
// ioredis' keyPrefix already namespaces by network (REDIS_PREFIX),
// so two networks' limiter quotas don't collide.

interface LimiterOpts {
  prefix: string;
  windowSec: number;
  points: number;
}

function buildLimiter(opts: LimiterOpts): RateLimiterRedis {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `rl:${opts.prefix}`,
    points: opts.points,
    duration: opts.windowSec,
  });
}

const reads = buildLimiter({
  prefix: 'reads',
  windowSec: 60,
  points: config.RATE_LIMIT_READS_PER_MIN,
});

const search = buildLimiter({
  prefix: 'search',
  windowSec: 60,
  points: config.RATE_LIMIT_SEARCH_PER_MIN,
});

const sseSubscribe = buildLimiter({
  prefix: 'sse-sub',
  windowSec: 60,
  points: config.RATE_LIMIT_SSE_SUBSCRIBE_PER_MIN,
});

// Global RPS ceiling — sits on top of the per-IP limiters. Catches
// distributed floods that wouldn't trip any single IP's quota.
const globalCeiling = buildLimiter({
  prefix: 'global',
  windowSec: 1,
  points: config.RATE_LIMIT_GLOBAL_RPS,
});

function reject(res: Response, info: RateLimiterRes, message: string): void {
  const retryAfter = Math.ceil(info.msBeforeNext / 1000);
  res.set('Retry-After', String(retryAfter));
  res.status(HttpStatus.TOO_MANY_REQUESTS).send({
    errors: [new ErrorModel(
      HttpStatus.TOO_MANY_REQUESTS,
      'Too Many Requests',
      `${message} Try again in ${retryAfter} seconds.`,
    )],
  });
}

function makeMiddleware(limiter: RateLimiterRedis, label: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      // Global ceiling consumed first so a flood doesn't burn per-IP
      // budget before being shed.
      await globalCeiling.consume('__global__');
      await limiter.consume(ip);
      next();
    } catch (err) {
      // RateLimiterRes is the rejection shape; anything else is a
      // Redis hiccup and we fail-open rather than 500 the public API.
      if (err && typeof (err as RateLimiterRes).msBeforeNext === 'number') {
        reject(res, err as RateLimiterRes, `${label} rate limit exceeded.`);
        return;
      }
      next();
    }
  };
}

export const readsLimiter = makeMiddleware(reads, 'Reads');
export const searchLimiter = makeMiddleware(search, 'Search');
export const sseSubscribeLimiter = makeMiddleware(sseSubscribe, 'SSE subscribe');
