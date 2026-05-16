import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import Joi from 'joi';
import { ch } from '../lib/ch';
import { halford2grc } from '../lib/halford';
import { isHiddenPoll } from '../lib/hiddenPolls';
import { meili, meiliIndexId, MeiliIndexName } from '../lib/meili';
import { getWallet, searchWalletsByPrefix } from '../lib/redis';
import { withMeta } from '../lib/responseMeta';
import { SEARCH_QUERY } from '../lib/validators';
import { validate } from '../middleware/validate';

export const searchRouter = Router();

const MEILI_INDICES: MeiliIndexName[] = [
  'superblocks', 'polls', 'beacons', 'messages',
];
// Logical buckets that are NOT Meili indexes but are still surfaced in
// the response under these names so the frontend keeps requesting them,
// the single-hit redirect keeps working, and Joi keeps accepting them:
//   - blocks / transactions / claims → ClickHouse point lookups.
//   - addresses → Redis rich-list ZSET.
const CH_BUCKETS = ['blocks', 'transactions', 'claims'] as const;
type ChBucket = (typeof CH_BUCKETS)[number];
const ADDRESS_BUCKET = 'addresses' as const;
// Researcher display-name → CPID. The `cpid_names` Meili index was
// retired (memory budget); name resolution lives in CH `project_users`
// and is exposed by `/cpids/resolve`. The global search bar must cover
// it too — without this bucket, typing a BOINC username returns
// nothing. The frontend already renders `cpid_names`.
const NAMES_BUCKET = 'cpid_names' as const;
type SearchableBucket =
  | MeiliIndexName | ChBucket | typeof ADDRESS_BUCKET | typeof NAMES_BUCKET;
const ALL_INDICES: SearchableBucket[] = [
  ...MEILI_INDICES, ...CH_BUCKETS, ADDRESS_BUCKET, NAMES_BUCKET,
];

interface SearchHit { index: SearchableBucket; hits: Record<string, unknown>[]; estimatedTotalHits?: number }

// Exact-identifier search over the CH-owned buckets. Block / tx / claim
// search is never fuzzy — the user pastes a height, a 64-hex block
// hash or tx id, or a 32-hex CPID — so we only run the query whose
// shape the input can actually satisfy (no blind full scans), and we
// return the same minimal field set the old Meili docs carried so the
// frontend's linkFor / labelFor are untouched.
async function chSearch(q: string, limit: number, want: Set<ChBucket>): Promise<SearchHit[]> {
  const v = q.toLowerCase();
  const isHex64 = /^[0-9a-f]{64}$/.test(v);
  const isHex32 = /^[0-9a-f]{32}$/.test(v);
  const asUint32 = /^[0-9]{1,10}$/.test(v) && Number(v) <= 4294967295 ? Number(v) : null;

  const jobs: Array<Promise<SearchHit | null>> = [];

  if (want.has('transactions') && isHex64) {
    jobs.push(ch.query({
      query: 'SELECT tx_id FROM transactions FINAL WHERE tx_id = {q:String} LIMIT {lim:UInt32}',
      query_params: { q: v, lim: limit },
      format: 'JSONEachRow',
    }).then((r) => r.json<{ tx_id: string }>()).then((rows) => ({
      index: 'transactions' as const,
      hits: rows.map((row) => ({ id: row.tx_id, tx_id: row.tx_id })),
      estimatedTotalHits: rows.length,
    })).catch(() => null));
  }

  if (want.has('blocks') && (isHex64 || asUint32 !== null)) {
    const where = isHex64 ? 'hash = {q:String}' : 'height = {h:UInt32}';
    jobs.push(ch.query({
      query: `SELECT height, is_superblock FROM blocks FINAL WHERE ${where} LIMIT {lim:UInt32}`,
      query_params: { q: v, h: asUint32 ?? 0, lim: limit },
      format: 'JSONEachRow',
    }).then((r) => r.json<{ height: number; is_superblock: boolean }>()).then((rows) => ({
      index: 'blocks' as const,
      hits: rows.map((row) => ({
        id: String(row.height), height: row.height, is_superblock: row.is_superblock,
      })),
      estimatedTotalHits: rows.length,
    })).catch(() => null));
  }

  if (want.has('claims') && (isHex32 || asUint32 !== null)) {
    const where = isHex32 ? 'cpid = {q:String}' : 'block_height = {h:UInt32}';
    jobs.push(ch.query({
      query: `SELECT block_height, organization, cpid FROM claims FINAL WHERE ${where} LIMIT {lim:UInt32}`,
      query_params: { q: v, h: asUint32 ?? 0, lim: limit },
      format: 'JSONEachRow',
    }).then((r) => r.json<{ block_height: number; organization: string; cpid: string | null }>())
      .then((rows) => ({
        index: 'claims' as const,
        hits: rows.map((row) => ({
          id: String(row.block_height),
          block_height: row.block_height,
          organization: row.organization,
          cpid: row.cpid ?? '',
        })),
        estimatedTotalHits: rows.length,
      })).catch(() => null));
  }

  const settled = await Promise.all(jobs);
  return settled.filter((s): s is SearchHit => s !== null && s.hits.length > 0);
}

// Audit P0 #10. q ≤ 256 (closes L5 unbounded Meili input), indices
// must be a comma-separated subset of ALL_INDICES (closes the
// audit's "indices ⊂ ALL_INDICES" requirement at the edge), limit
// clamped to 1–100. Joi runs in `validate` middleware so the route
// handler can assume well-formed query.
const searchQuerySchema = Joi.object({
  q: SEARCH_QUERY.optional().allow(''),
  indices: Joi.string()
    .max(256)
    .pattern(/^[a-z,_]+$/i)
    .custom((value: string, helpers) => {
      const names = value.split(',').filter(Boolean);
      const bad = names.filter((n) => !ALL_INDICES.includes(n as SearchableBucket));
      if (bad.length > 0) return helpers.error('any.invalid', { bad });
      return value;
    })
    .optional(),
  limit: Joi.number().integer().min(1).max(100)
    .optional(),
}).unknown(true);

searchRouter.get('/', validate({ query: searchQuerySchema }), async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(StatusCodes.OK).send(withMeta({ data: [] }));
    return;
  }
  const requested = String(req.query.indices ?? '').trim();
  const indices: SearchableBucket[] = requested
    ? requested.split(',').filter((n): n is SearchableBucket => ALL_INDICES.includes(n as SearchableBucket))
    : ALL_INDICES;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);

  // Meili pass — only the fuzzy-text indexes Meili actually owns.
  const meiliIndices = indices.filter(
    (n): n is MeiliIndexName => (MEILI_INDICES as SearchableBucket[]).includes(n),
  );
  const results: SearchHit[] = await Promise.all(
    meiliIndices.map(async (index) => {
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

  // ClickHouse pass — block / transaction / claim are exact-id point
  // lookups served from CH primary keys instead of a Meili inverted
  // index (see `MeiliIndexName`). Same response buckets, so the
  // frontend and the single-hit redirect are unaffected.
  const chWanted = new Set(
    indices.filter((n): n is ChBucket => (CH_BUCKETS as readonly string[]).includes(n)),
  );
  if (chWanted.size > 0) {
    results.push(...await chSearch(q, limit, chWanted));
  }

  // Address prefix lookup. Addresses are NOT in Meili (per-balance churn
  // would punish the index, and Redis already has the rich-list ZSET).
  // ZSCAN `wallets:by_balance` for prefix matches and HGETALL the matched
  // wallet rows for the surfaced metadata.
  if (indices.includes(ADDRESS_BUCKET) && q.length >= 3) {
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
      results.push({
        index: ADDRESS_BUCKET,
        hits: dbHits.slice(0, limit),
        estimatedTotalHits: dbHits.length,
      });
    } catch (_err) {
      /* swallow — search must not 500 just because the wallet lookup hiccupped */
    }
  }

  // Researcher display-name lookup. Mirrors `/cpids/resolve` (exact
  // name match, highest-credit project first) so the search bar and
  // the /cpids/<name> redirect resolve identically. Served from CH
  // `project_users`, NOT Meili (the `cpid_names` index was retired).
  if (indices.includes(NAMES_BUCKET) && q.length >= 2) {
    try {
      const r = await ch.query({
        // No FINAL: it ignores the idx_project_users_name bloom and
        // full-scans ~5.8M rows. WHERE name prunes via the bloom
        // (migration 0032); dedup each (cpid,project_name) to its
        // latest _seq and re-assert the name post-dedup (HAVING) so a
        // stale rename can't surface — exactly resolveCpidNames'
        // verified pattern.
        query: `
          SELECT cpid, disp_name AS name, project_name FROM (
            SELECT cpid, project_name,
                   argMax(name, _seq)         AS disp_name,
                   argMax(total_credit, _seq) AS total_credit
            FROM project_users
            WHERE name = {name: String}
            GROUP BY cpid, project_name
            HAVING disp_name = {name: String}
          )
          ORDER BY total_credit DESC
          LIMIT {lim: UInt32}
        `,
        query_params: { name: q, lim: limit },
        format: 'JSONEachRow',
      });
      const rows = await r.json<{ cpid: string; name: string; project_name: string }>();
      results.push({
        index: NAMES_BUCKET,
        hits: rows.map((m) => ({
          id: `${m.cpid}:${m.project_name}`,
          cpid: m.cpid,
          name: m.name,
          project_name: m.project_name,
        })),
        estimatedTotalHits: rows.length,
      });
    } catch (_err) {
      /* project_users absent (pre-migration) or hiccup — search must not 500 */
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
