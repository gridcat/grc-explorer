import { Request, Response, NextFunction } from 'express';
import HttpStatus from 'http-status-codes';
import { config } from '../config';
import { ErrorModel } from '../lib/errors';

/**
 * Per-IP sliding-window rate limiter (60s window). Stale buckets get
 * swept on a background timer that's `.unref()`'d so it doesn't pin
 * the event loop open in tests.
 *
 * `req.ip` respects Express's `trust proxy` setting — when the
 * explorer runs behind nginx the limiter sees the real client.
 */
export function createRateLimiter(windowMs: number, maxRequests: number) {
  const requests = new Map<string, number[]>();

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    requests.forEach((timestamps, ip) => {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) requests.delete(ip);
      else requests.set(ip, valid);
    });
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (requests.get(ip) || []).filter((t) => t > windowStart);

    if (timestamps.length >= maxRequests) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).send({
        errors: [new ErrorModel(
          HttpStatus.TOO_MANY_REQUESTS,
          'Too Many Requests',
          `Rate limit exceeded. Try again in ${Math.ceil(windowMs / 1000)} seconds.`,
        )],
      });
      return;
    }

    timestamps.push(now);
    requests.set(ip, timestamps);
    next();
  };
}

const ONE_MINUTE_MS = 60_000;

export const readsLimiter = createRateLimiter(ONE_MINUTE_MS, config.RATE_LIMIT_READS_PER_MIN);
export const searchLimiter = createRateLimiter(ONE_MINUTE_MS, config.RATE_LIMIT_SEARCH_PER_MIN);
export const sseSubscribeLimiter = createRateLimiter(ONE_MINUTE_MS, config.RATE_LIMIT_SSE_SUBSCRIBE_PER_MIN);
