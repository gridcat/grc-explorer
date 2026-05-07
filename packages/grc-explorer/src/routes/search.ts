import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { halford2grc } from '../lib/halford';
import { isHiddenPoll } from '../lib/hiddenPolls';
import { meili, meiliIndexId, MeiliIndexName } from '../lib/meili';
import { getWallet, searchWalletsByPrefix } from '../lib/redis';
import { withMeta } from '../lib/responseMeta';

export const searchRouter = Router();

const ALL_INDICES: MeiliIndexName[] = [
  'blocks', 'transactions', 'addresses', 'claims',
  'superblocks', 'polls', 'beacons', 'messages',
];

interface SearchHit { index: MeiliIndexName; hits: Record<string, unknown>[]; estimatedTotalHits?: number }

searchRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(StatusCodes.OK).send(withMeta({ data: [] }));
    return;
  }
  const requested = String(req.query.indices ?? '').trim();
  const indices = requested
    ? requested.split(',').filter((n): n is MeiliIndexName => ALL_INDICES.includes(n as MeiliIndexName))
    : ALL_INDICES;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);

  const results: SearchHit[] = await Promise.all(
    indices.map(async (index) => {
      try {
        const r = await meili.index(meiliIndexId(index)).search(q, { limit });
        let hits = r.hits as Record<string, unknown>[];
        let total = r.estimatedTotalHits;
        if (index === 'polls') {
          const before = hits.length;
          hits = hits.filter((h) => !isHiddenPoll(String(h.id ?? '')));
          if (typeof total === 'number') total = Math.max(0, total - (before - hits.length));
        }
        return { index, hits, estimatedTotalHits: total };
      } catch (_err) {
        return { index, hits: [], estimatedTotalHits: 0 };
      }
    }),
  );

  // Address prefix lookup. The indexer doesn't push addresses to Meili
  // (per-balance churn would punish the index), so we ZSCAN the
  // `wallets:by_balance` Redis ZSET for prefix matches and HGETALL the
  // matched wallet rows for the surfaced metadata.
  if (indices.includes('addresses') && q.length >= 3) {
    try {
      const matches = await searchWalletsByPrefix(q, limit);
      const wallets = await Promise.all(matches.map(getWallet));
      const dbHits = wallets
        .filter((w): w is NonNullable<typeof w> => w !== null)
        .map((w) => ({
          id: w.address,
          address: w.address,
          balance: halford2grc(w.balance),
          tx_count: w.txCount,
        }));
      const addrBucket = results.find((r) => r.index === 'addresses');
      if (addrBucket) {
        const seen = new Set<string>();
        const merged: Record<string, unknown>[] = [];
        for (const hit of [...dbHits, ...addrBucket.hits]) {
          const key = String(hit.address ?? hit.id ?? '');
          if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(hit);
          }
        }
        addrBucket.hits = merged.slice(0, limit);
        addrBucket.estimatedTotalHits = Math.max(merged.length, addrBucket.estimatedTotalHits ?? 0);
      }
    } catch (_err) {
      /* swallow — search must not 500 just because the wallet lookup hiccupped */
    }
  }

  res.status(StatusCodes.OK).send(withMeta({
    data: results,
    meta: {
      query: q,
      total: results.reduce((acc, r) => acc + (r.estimatedTotalHits ?? 0), 0),
    },
  }));
});
