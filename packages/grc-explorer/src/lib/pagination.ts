import { Request } from 'express';

export interface Pagination {
  offset: number;
  limit: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function getPagination(req: Request): Pagination {
  const query = req.query as Record<string, unknown>;
  const page = (query?.page ?? {}) as Record<string, string | undefined>;
  let limit = parseInt(page.size ?? '', 10) || DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  const offset = parseInt(page.offset ?? '', 10)
    || (parseInt(page.number ?? '', 10) - 1) * limit
    || 0;
  return { offset: Math.max(0, offset), limit };
}
