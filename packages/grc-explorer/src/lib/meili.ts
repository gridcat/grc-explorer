import { MeiliSearch } from 'meilisearch';
import { config } from '../config';
import { redis } from './redis';

export const meili = new MeiliSearch({
  host: config.MEILI_HOST,
  apiKey: config.MEILI_API_KEY,
});

// Active chain-derived Meili indexes — only the corpora whose value is
// fuzzy full-text. Everything that's an exact-identifier lookup is
// served from its primary store instead, because a full inverted index
// over millions of those rows was the bulk of Meili's resident memory
// and bought nothing a point lookup doesn't already do:
//   - `blocks` / `transactions` / `claims` → ClickHouse (block height /
//     hash / tx_id / cpid are PK-class point lookups; `search.ts`
//     queries CH directly and still surfaces them under the same
//     response buckets).
//   - `addresses` → Redis (`search.ts` ZSCANs `wallets:by_balance`).
//   - `cpid_names` → CH `project_users` (`cpids.ts:/resolve`).
// On a memory-constrained box the ~31 GiB those exact-id indexes cost
// is unaffordable and unjustified; Meili keeps only the genuinely
// fuzzy corpora (poll text, transaction messages, project names).
export type MeiliIndexName =
  | 'superblocks'
  | 'polls'
  | 'beacons'
  | 'messages';

export function meiliIndexId(name: MeiliIndexName): string {
  return meiliIndexIdRaw(name);
}

// Same id construction without the union constraint — used by the
// boot-time cleanup that drops indexes no longer in `MeiliIndexName`
// (their literals can't satisfy the narrowed type).
export function meiliIndexIdRaw(name: string): string {
  return `${config.MEILI_INDEX_PREFIX}_${name}`;
}

export interface MeiliEnvelope {
  index: MeiliIndexName;
  action: 'upsert' | 'delete';
  /** Document for upsert, or `{ id }` for delete. */
  doc: Record<string, unknown>;
}

const STREAM_KEY = 'meili:queue';

// MeiliIndexer persists its stream position here (unprefixed — ioredis
// adds the keyspace prefix, same as STREAM_KEY) so a restart RESUMES
// instead of replaying the stream from 0-0. Cleared by the wipe path.
const CURSOR_KEY = 'meili:cursor';

// Approximate cap on the durable stream. Its job is to survive a Meili
// outage without losing live envelopes, NOT to be a from-genesis replay
// log — that's what a deliberate reindex is for. With the persisted
// cursor a restart resumes, so this only has to cover producer-ahead-of-
// down-consumer lag; 1M entries is months at live cadence. `~` lets
// Redis trim in whole macro-nodes (cheap) instead of exactly per-add.
const STREAM_MAXLEN = 1_000_000;

/**
 * Enqueue a Meili sync envelope. Called from the indexer's block-write
 * path *after* the DB transaction commits. The Redis Stream gives us
 * durability (Meili can be down for hours without losing data),
 * backpressure (stream length signals indexer-faster-than-search), and
 * replay (a CLI rebuilder re-emits the corpus into the same stream).
 */
export async function enqueueMeili(envelope: MeiliEnvelope): Promise<void> {
  await redis.xadd(
    STREAM_KEY,
    'MAXLEN',
    '~',
    STREAM_MAXLEN,
    '*',
    'index',
    envelope.index,
    'action',
    envelope.action,
    'doc',
    JSON.stringify(envelope.doc),
  );
}

/**
 * Batched variant. A backfilled mainnet block routinely produces a
 * dozen envelopes (1 block doc + N tx docs + claim/superblock/poll/beacon
 * docs); issuing those as serial `await xadd` calls is one TCP round
 * trip each, and that latency dominated post-commit time during
 * catch-up. ioredis auto-pipelines commands fired in the same tick of
 * the event loop, so dispatching all of them then awaiting Promise.all
 * collapses N round trips into one.
 */
export async function enqueueMeiliBatch(envelopes: MeiliEnvelope[]): Promise<void> {
  if (envelopes.length === 0) return;
  await Promise.all(envelopes.map((env) => redis.xadd(
    STREAM_KEY,
    'MAXLEN',
    '~',
    STREAM_MAXLEN,
    '*',
    'index',
    env.index,
    'action',
    env.action,
    'doc',
    JSON.stringify(env.doc),
  )));
}

export const MEILI_STREAM_KEY = STREAM_KEY;

// --- Durable consumer cursor -------------------------------------------
// Persisted after each successful flush so a restart resumes from where
// the drain left off rather than replaying the whole stream. At-least-
// once: a crash between flush and save reprocesses one batch, which is
// safe (upserts are keyed by primary key, deletes are idempotent).

export async function loadMeiliCursor(): Promise<string | null> {
  return redis.get(CURSOR_KEY);
}

export async function saveMeiliCursor(id: string): Promise<void> {
  await redis.set(CURSOR_KEY, id);
}

// Called by the wipe path alongside flushing the stream + dropping
// indexes, so the post-wipe drain starts cleanly from the reborn
// stream instead of a stale saved position.
export async function clearMeiliCursor(): Promise<void> {
  await redis.del(CURSOR_KEY);
}
