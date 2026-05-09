import { log } from '../../lib/log';
import {
  meili, meiliIndexId, MeiliEnvelope, MEILI_STREAM_KEY, MeiliIndexName,
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

  private aborted = false;

  private lastId = '0-0';

  abort(): void {
    this.aborted = true;
  }

  async run(): Promise<void> {
    await this.ensureIndices();

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

    for (const [index, docs] of upserts.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await meili.index(meiliIndexId(index)).addDocuments(docs);
      } catch (err) {
        log.warn(`MeiliIndexer: addDocuments(${index}) failed`, err);
      }
    }

    for (const [index, ids] of deletes.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await meili.index(meiliIndexId(index)).deleteDocuments(ids);
      } catch (err) {
        log.warn(`MeiliIndexer: deleteDocuments(${index}) failed`, err);
      }
    }
  }

  private async ensureIndices(): Promise<void> {
    type IndexSetting = {
      name: MeiliIndexName;
      primaryKey: string;
      searchable?: string[];
      filterable?: string[];
      sortable?: string[];
    };
    const settings: IndexSetting[] = [
      {
        name: 'blocks', primaryKey: 'id', searchable: ['hash', 'prev_hash', 'miner_address', 'staker_cpid'], filterable: ['is_pos', 'is_superblock', 'height'], sortable: ['height', 'time'],
      },
      {
        name: 'transactions', primaryKey: 'id', searchable: ['tx_id', 'block_hash', 'hashboinc'], filterable: ['is_coinbase', 'is_coinstake', 'has_contract', 'block_height'], sortable: ['time'],
      },
      {
        name: 'addresses', primaryKey: 'id', searchable: ['address'], filterable: [], sortable: ['balance', 'tx_count'],
      },
      {
        name: 'claims', primaryKey: 'id', searchable: ['cpid', 'organization', 'client_version', 'mining_id'], filterable: ['is_mrc'], sortable: ['block_height'],
      },
      // Searchable on quorum hash, on the height (string-form so users
      // can type "89000"), and on the per-project / per-CPID
      // breakdowns so a query for a project name like "Enigma@Home"
      // surfaces every superblock that included it.
      {
        name: 'superblocks', primaryKey: 'id', searchable: ['quorum_hash', 'height_str', 'projects', 'cpids'], filterable: [], sortable: ['height', 'total_magnitude'],
      },
      {
        name: 'polls', primaryKey: 'id', searchable: ['title', 'question', 'options'], filterable: ['response_type', 'weight_type'], sortable: ['start_time', 'end_time'],
      },
      {
        name: 'beacons', primaryKey: 'id', searchable: ['cpid', 'address'], filterable: ['status'], sortable: ['block_height', 'expiration'],
      },
      // Free-form transaction messages (`MESSAGE` contracts). The
      // entire payload IS the message text — searchable on `message`,
      // sortable by `time` so the search page can rank recent first.
      {
        name: 'messages', primaryKey: 'id', searchable: ['message', 'sender_address'], filterable: [], sortable: ['time', 'block_height'],
      },
    ];

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
