import { MeiliSearch } from 'meilisearch';
import { config } from '../config';
import { redis } from './redis';

export const meili = new MeiliSearch({
  host: config.MEILI_HOST,
  apiKey: config.MEILI_API_KEY,
});

export type MeiliIndexName =
  | 'blocks'
  | 'transactions'
  | 'addresses'
  | 'claims'
  | 'superblocks'
  | 'polls'
  | 'beacons'
  | 'messages'
  // Off-chain enrichment: maps BOINC project usernames to the
  // matching on-chain CPID so the global search box resolves a name
  // like "Alice" back to her CPID detail page. Populated by
  // BoincStatsImportJob; one document per (cpid, project_name) pair.
  | 'cpid_names';

export function meiliIndexId(name: MeiliIndexName): string {
  return `${config.MEILI_INDEX_PREFIX}_${name}`;
}

export interface MeiliEnvelope {
  index: MeiliIndexName;
  action: 'upsert' | 'delete';
  /** Document for upsert, or `{ id }` for delete. */
  doc: Record<string, unknown>;
}

const STREAM_KEY = 'meili:queue';

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
