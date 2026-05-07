import { Request } from 'express';

/**
 * Express 5 (and recent @types/express) types `req.params.x` and
 * `req.query.x` as `string | string[]` because parsers like qs can
 * return arrays for repeated keys (`?foo=a&foo=b`). Most route code
 * just wants the first scalar — these helpers normalise that, so
 * each route doesn't need its own `Array.isArray` check.
 */
export function param(req: Request, key: string): string {
  const v = req.params[key as keyof typeof req.params] as unknown;
  if (Array.isArray(v)) return String(v[0] ?? '');
  return String(v ?? '');
}

export function queryStr(req: Request, key: string): string {
  const v = req.query[key as keyof typeof req.query] as unknown;
  if (Array.isArray(v)) return String(v[0] ?? '');
  return String(v ?? '');
}
