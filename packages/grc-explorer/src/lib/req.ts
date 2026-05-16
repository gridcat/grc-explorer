import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ErrorModel } from './errors';

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

/**
 * Parse the `range=year&year=YYYY` query contract shared by the
 * /projects, /metrics, and /network history endpoints. Sends a
 * JSON:API 400 directly and returns null when invalid; on success
 * returns the shape every caller needs.
 *
 *   const yr = parseYearRange(req, res);
 *   if (!yr) return;
 *   const { isYear, year } = yr;
 */
export function parseYearRange(req: Request, res: Response): { isYear: boolean; year: number | null } | null {
  const range = queryStr(req, 'range').toLowerCase() || 'all';
  const isYear = range === 'year';
  if (!isYear) return { isYear: false, year: null };
  const year = parseInt(queryStr(req, 'year'), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Bad Request', 'range=year requires year=YYYY')],
    });
    return null;
  }
  return { isYear: true, year };
}

/**
 * Parse a clamped integer from `req.query[key]`. Defaults to `def`
 * when the query value is missing or non-numeric; clamps to
 * `[min, max]` regardless. Drop-in replacement for the
 * `Math.min(Math.max(parseInt(String(req.query.X ?? 'D'), 10) || D, MIN), MAX)`
 * pattern that recurs in ~15 places.
 */
export function clampedQueryInt(
  req: Request,
  key: string,
  { def, min, max }: { def: number; min: number; max: number },
): number {
  const raw = parseInt(queryStr(req, key), 10);
  const v = Number.isFinite(raw) ? raw : def;
  return Math.min(Math.max(v, min), max);
}
