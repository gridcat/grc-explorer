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

/**
 * `?sort=height` for oldest first; anything else (absent, `-height`) is
 * the default newest first. Both directions are the same index range
 * read, so a staker's FIRST block is page 1 of `?sort=height`, not a
 * deep OFFSET into the newest-first list.
 */
export function heightOrder(req: Request): 'ASC' | 'DESC' {
  return req.query.sort === 'height' ? 'ASC' : 'DESC';
}
