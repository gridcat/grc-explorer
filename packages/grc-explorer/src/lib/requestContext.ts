import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

// Per-request signal store. Express 5 hands every request an
// `AbortSignal` that fires when the client disconnects. We park it
// in AsyncLocalStorage so downstream helpers (CH queries, RPC calls,
// future Meili lookups) can read it without every signature gaining
// a `signal` parameter.
//
// Background workers (indexer, scheduled jobs) run outside any
// request and read no context — `getRequestSignal()` returns
// undefined, callers thread `undefined` through, the underlying
// libraries treat that as "no abort". Same shape as a route that
// hasn't reached the middleware.
//
// We bridge `req.on('close')` → `AbortController.abort()` ourselves
// rather than relying on `req.signal` directly because @types/express
// hasn't caught up to the Express 5 native signal API yet, and the
// connection-close event has been there since Express 3.

interface RequestContext {
  signal: AbortSignal;
}

const store = new AsyncLocalStorage<RequestContext>();

export function getRequestSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  store.run({ signal: controller.signal }, next);
}
