import { log } from '../../lib/log';
import {
  meili, meiliIndexId, meiliIndexIdRaw, MeiliEnvelope, MEILI_STREAM_KEY, MeiliIndexName,
  loadMeiliCursor, saveMeiliCursor, clearMeiliCursor,
} from '../../lib/meili';
import { isWipeInProgress, redisStreams } from '../../lib/redis';

// ioredis 5.x auto-prefixes XREAD's stream-key positions just like any
// other key argument, so we pass the unprefixed key and let the client
// add the prefix. Passing the FQN here would double-prefix and silently
// read from a stream that doesn't exist.

/**
 * Drains the Redis Stream `meili:queue` into Meilisearch in batches.
 * Decoupling this from the indexer's block-write path means a
 * Meilisearch outage can't stall block ingestion — the stream just
 * grows until Meili is back.
 *
 * Batches per index up to BATCH_SIZE documents or BATCH_TIMEOUT_MS,
 * whichever comes first. Uses XREAD with BLOCK so the worker idles
 * cheaply when there's nothing to do.
 */
export class MeiliIndexer {
  private static readonly BATCH_SIZE = 1000;

  private static readonly BLOCK_MS = 2000;

  // The `meili:queue` Redis stream is durable and never trimmed, so a
  // restart replays it from 0-0 — and after a from-genesis backfill
  // that's ~19M historical envelopes, including ones for indexes that
  // have since been removed from `MeiliIndexName` (blocks / transactions
  // / claims moved to ClickHouse — see lib/meili.ts). Without this guard
  // `flush()` would happily `addDocuments` against those stale index
  // names and re-create the multi-GB indexes Option A dropped. Skipping
  // them here makes the replay a cheap Redis-read/JSON-parse drain with
  // zero Meili work. Keep in sync with `settings` in `ensureIndices`;
  // the `MeiliIndexName` type bounds the literals.
  private static readonly ACTIVE_INDEXES: ReadonlySet<MeiliIndexName> = new Set<MeiliIndexName>([
    'superblocks', 'polls', 'beacons', 'messages',
  ]);

  private aborted = false;

  private lastId = '0-0';

  abort(): void {
    this.aborted = true;
  }

  async run(): Promise<void> {
    await this.ensureIndices();

    // Resume from the persisted position. Absent (first run ever, or
    // post-wipe) → 0-0, which reads the stream from the start exactly
    // once; every later restart picks up where the drain left off
    // instead of replaying millions of historical envelopes.
    this.lastId = (await loadMeiliCursor()) ?? '0-0';

    while (!this.aborted) {
      try {
        // Skip drain ticks while a wipe is in progress. The wipe drops
        // the Meili index AND flushes the prefixed Redis stream, so we
        // mustn't race it by replaying old envelopes into the freshly-
        // empty index. Re-reading lastId post-wipe is safe — the stream
        // is reborn at 0-0 and our cached lastId is treated as < first.
        // eslint-disable-next-line no-await-in-loop
        if (await isWipeInProgress()) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((r) => { setTimeout(r, 1000); });
          this.lastId = '0-0';
          // Drop the saved position too, so a restart mid-wipe also
          // starts from the reborn (flushed) stream rather than a
          // stale id that now points past the new first entry.
          // eslint-disable-next-line no-await-in-loop
          await clearMeiliCursor();
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await redisStreams.xread(
          'COUNT',
          MeiliIndexer.BATCH_SIZE,
          'BLOCK',
          MeiliIndexer.BLOCK_MS,
          'STREAMS',
          MEILI_STREAM_KEY,
          this.lastId,
        );
        if (!result) continue;

        const envelopes: MeiliEnvelope[] = [];
        let highest = this.lastId;
        for (const [, messages] of result) {
          for (const [id, fields] of messages) {
            highest = id;
            const fieldMap = MeiliIndexer.fieldsToMap(fields);
            try {
              envelopes.push({
                index: fieldMap.get('index') as MeiliIndexName,
                action: fieldMap.get('action') as 'upsert' | 'delete',
                doc: JSON.parse(fieldMap.get('doc') ?? '{}'),
              });
            } catch (err) {
              log.warn(`MeiliIndexer: malformed envelope ${id}`, err);
            }
          }
        }

        // eslint-disable-next-line no-await-in-loop
        await this.flush(envelopes);
        this.lastId = highest;
        // Persist AFTER the flush so the saved position never points
        // ahead of what Meili actually has. At-least-once on crash.
        // eslint-disable-next-line no-await-in-loop
        await saveMeiliCursor(highest);
      } catch (err) {
        log.warn('MeiliIndexer: drain loop error', err);
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => { setTimeout(resolve, 1000); });
      }
    }
  }

  private async flush(envelopes: MeiliEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;

    // Bucket by (index, action) so we send one Meili request per batch.
    const upserts = new Map<MeiliIndexName, Record<string, unknown>[]>();
    const deletes = new Map<MeiliIndexName, string[]>();
    for (const env of envelopes) {
      // Drop envelopes for indexes no longer served by Meili (stale
      // stream replay after a backfill). env.index is typed but at
      // runtime carries whatever the historical envelope wrote.
      if (!MeiliIndexer.ACTIVE_INDEXES.has(env.index)) continue;
      if (env.action === 'upsert') {
        const arr = upserts.get(env.index) ?? [];
        arr.push(env.doc);
        upserts.set(env.index, arr);
      } else if (env.action === 'delete') {
        const arr = deletes.get(env.index) ?? [];
        arr.push(String(env.doc.id));
        deletes.set(env.index, arr);
      }
    }

    // Meili tolerates concurrent writes across distinct indices, so the
    // upsert and delete fan-outs run in parallel — backfill catch-up
    // used to serialise 9 indices for ~9× the wallclock.
    await Promise.all([
      ...Array.from(upserts.entries()).map(async ([index, docs]) => {
        try {
          await meili.index(meiliIndexId(index)).addDocuments(docs);
        } catch (err) {
          log.warn(`MeiliIndexer: addDocuments(${index}) failed`, err);
        }
      }),
      ...Array.from(deletes.entries()).map(async ([index, ids]) => {
        try {
          await meili.index(meiliIndexId(index)).deleteDocuments(ids);
        } catch (err) {
          log.warn(`MeiliIndexer: deleteDocuments(${index}) failed`, err);
        }
      }),
    ]);
  }

  private async ensureIndices(): Promise<void> {
    type IndexSetting = {
      name: MeiliIndexName;
      primaryKey: string;
      searchable?: string[];
      filterable?: string[];
      sortable?: string[];
    };
    // Each `searchable` field builds a full inverted index, which is
    // where Meili's RAM cost comes from. Keep only the keys the search
    // bar actually has to resolve; lookups by address/cpid/etc. that
    // already have a direct backend path (Redis, CH primary key) stay
    // there. See `MeiliIndexName` for why `addresses` and `cpid_names`
    // were removed.
    const settings: IndexSetting[] = [
      // blocks / transactions / claims are intentionally absent — they
      // moved to ClickHouse point lookups (see `MeiliIndexName`). The
      // remaining indexes are the fuzzy-text corpora only.
      //
      // `cpids` was the biggest single bloat source (1 KB+ of joined
      // CPID strings per doc × thousands of superblocks → multi-GB
      // inverted index). Users looking for a CPID hit `/cpids/<id>` or
      // the claims index instead.
      {
        name: 'superblocks', primaryKey: 'id', searchable: ['quorum_hash', 'height_str', 'projects'], filterable: [], sortable: ['height', 'total_magnitude'],
      },
      {
        name: 'polls', primaryKey: 'id', searchable: ['title', 'question', 'options'], filterable: ['response_type', 'weight_type'], sortable: ['start_time', 'end_time'],
      },
      {
        name: 'beacons', primaryKey: 'id', searchable: ['cpid'], filterable: ['status'], sortable: ['block_height', 'expiration'],
      },
      // Free-form transaction messages (`MESSAGE` contracts). The
      // entire payload IS the message text — searchable on `message`,
      // sortable by `time` so the search page can rank recent first.
      {
        name: 'messages', primaryKey: 'id', searchable: ['message'], filterable: [], sortable: ['time', 'block_height'],
      },
    ];

    // One-shot cleanup: indexes that used to be in the schema but were
    // dropped from `MeiliIndexName`. Fire-and-forget the deletion task —
    // we don't await it, because when Meili has a deep task backlog
    // (right after a wipe) `waitForTask` will time out before the task
    // is even picked up. The enqueue itself is the load-bearing call;
    // Meili processes it on its own clock. Idempotent: deleting a
    // non-existent index 404s and we swallow that case.
    // `blocks` / `transactions` / `claims` join the list: existing
    // deployments carry ~31 GiB of those inverted indexes that this
    // boot reclaims now that the same lookups are served from CH.
    const obsoleteIndexes = ['addresses', 'cpid_names', 'blocks', 'transactions', 'claims'];
    for (const obsolete of obsoleteIndexes) {
      const id = meiliIndexIdRaw(obsolete);
      try {
        // eslint-disable-next-line no-await-in-loop
        await meili.deleteIndex(id);
        log.info(`MeiliIndexer: enqueued drop of obsolete index ${id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not found|index_not_found/i.test(message)) {
          log.warn(`MeiliIndexer: deleteIndex(${id}) failed`, err);
        }
      }
    }

    for (const s of settings) {
      const id = meiliIndexId(s.name);
      let createTaskUid: number | null = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        const enqueued = await meili.createIndex(id, { primaryKey: s.primaryKey });
        createTaskUid = enqueued.taskUid;
      } catch (err) {
        // Index already exists — fine. Log other errors but keep going.
        const message = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(message)) {
          log.warn(`MeiliIndexer: createIndex(${id}) failed`, err);
        }
      }
      // Meilisearch's createIndex is asynchronous — `await` resolves when
      // the task is enqueued, not when the index actually exists. Without
      // this wait, the heal block below would 404 on every fresh boot
      // because the index hasn't been created yet by the time we probe.
      if (createTaskUid !== null) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await meili.tasks.waitForTask(createTaskUid);
        } catch (_err) { /* let the heal probe surface real failures */ }
      }
      // Self-heal: indexes created before this code added `primaryKey: 'id'`
      // (or by a stray client) have `primaryKey: null`, and Meili then
      // tries to infer it from each batch — failing because every doc has
      // multiple `*id` fields (`tx_id`, `cpid`, `staker_cpid`, …). The
      // result is silent: HTTP 202 on enqueue, then "0 successful tasks
      // and 1 failed tasks" in Meili's scheduler log. Patch in place.
      // updateIndex is rejected with `index_primary_key_already_present`
      // once the index has any documents, so this only ever heals empty
      // indexes — exactly the broken case.
      try {
        // eslint-disable-next-line no-await-in-loop
        const info = await meili.getIndex(id);
        if (info.primaryKey == null) {
          // eslint-disable-next-line no-await-in-loop
          await meili.updateIndex(id, { primaryKey: s.primaryKey });
          log.info(`MeiliIndexer: patched ${id} primaryKey=${s.primaryKey}`);
        }
      } catch (err) {
        log.warn(`MeiliIndexer: primaryKey heal(${id}) failed`, err);
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await meili.index(id).updateSettings({
          searchableAttributes: s.searchable,
          filterableAttributes: s.filterable,
          sortableAttributes: s.sortable,
        });
      } catch (err) {
        log.warn(`MeiliIndexer: updateSettings(${id}) failed`, err);
      }
    }
  }

  private static fieldsToMap(fields: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1]);
    }
    return map;
  }
}
