import { query } from '../lib/db';
import { log } from '../lib/log';
import {
  meili, meiliIndexId, enqueueMeiliBatch, MeiliEnvelope, MeiliIndexName,
} from '../lib/meili';
import { normalizeProjectName } from '../lib/projectName';
import { closeRedis } from '../lib/redis';

// Rebuild the explorer's Meili corpora from MariaDB by re-emitting the
// SAME envelopes BlockWriter.buildMeiliEnvelopes produces per block,
// into the SAME meili:queue stream the live MeiliIndexer drains. This
// is the "deliberate reindex" the lib/meili.ts comment anticipates.
//
// Why re-emit instead of a Meili native dump/restore: on production the
// Meili instance is SHARED (grcbazaar indexes live in it too), and
// `meilisearch --import-dump` replaces the WHOLE instance — it would
// wipe every sibling index. Re-emitting envelopes only ever touches the
// four grc_explorer_mainnet_* indexes (index creation + searchable/
// filterable settings are applied by the running MeiliIndexer as it
// drains), so it is safe against a shared Meili.
//
// Needed after a physical DB restore (mariabackup): the restored rows
// are already present, so the indexer's boot reconcile advances the
// cursor without re-applying them — their Meili docs are therefore
// never re-emitted by normal operation. Run this once post-restore.
//
// The corpora are small (superblocks ~3k, polls ~1k, beacons ~50k,
// messages ~3k), so a full re-emit is cheap. Requires the explorer
// container to be UP so its MeiliIndexer consumes the stream.

const ENQUEUE_CHUNK = 1_000;

// The four fuzzy corpora this script owns (mirrors MeiliIndexer's
// ACTIVE_INDEXES). Obsolete indexes are dropped by MeiliIndexer's boot
// ensureIndices() — not our concern here.
const ACTIVE_INDEXES: MeiliIndexName[] = ['superblocks', 'polls', 'beacons', 'messages'];

// Clear existing docs from the explorer's own indexes before
// repopulating, so a rebuild after a physical DB restore doesn't leave
// stale documents behind — a prior deployment's rows that no longer
// exist in the restored DB, or malformed docs from before a shape fix
// (e.g. the old colon-id beacons). deleteAllDocuments KEEPS the index
// and the searchable/filterable/primaryKey settings MeiliIndexer
// applied on boot, so nothing has to be re-derived. Only touches
// grc_explorer_mainnet_* — sibling indexes on a shared Meili are safe.
// Awaits each clear so the repopulating upserts can't race ahead of it.
async function clearIndices(): Promise<void> {
  for (const name of ACTIVE_INDEXES) {
    const id = meiliIndexId(name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const task = await meili.index(id).deleteAllDocuments();
      // eslint-disable-next-line no-await-in-loop
      await meili.tasks.waitForTask(task.taskUid);
      log.info(`reindexMeili: cleared existing docs in ${id}`);
    } catch (err) {
      // A not-yet-created index (fresh Meili) 404s — nothing to clear.
      const message = err instanceof Error ? err.message : String(err);
      if (!/not.?found|index_not_found/i.test(message)) {
        log.warn(`reindexMeili: deleteAllDocuments(${id}) failed`, err);
      }
    }
  }
}

async function flush(envelopes: MeiliEnvelope[]): Promise<void> {
  for (let i = 0; i < envelopes.length; i += ENQUEUE_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    await enqueueMeiliBatch(envelopes.slice(i, i + ENQUEUE_CHUNK));
  }
}

async function reindexSuperblocks(): Promise<number> {
  // Space-joined normalized project names per superblock — grouped in
  // JS (normalizeProjectName is not expressible in SQL), same pattern
  // as buildMeiliEnvelopes' `superblockProjects.map(...).join(' ')`.
  const projRows = await query<{ superblock_height: number; project_name: string }>(
    'SELECT superblock_height, project_name FROM superblock_projects',
  );
  const projectsByHeight = new Map<number, string[]>();
  for (const r of projRows) {
    const h = Number(r.superblock_height);
    const list = projectsByHeight.get(h) ?? [];
    list.push(normalizeProjectName(r.project_name));
    projectsByHeight.set(h, list);
  }

  const rows = await query<{
    height: number; quorum_hash: string; total_magnitude: number | string;
    cpid_count: number; project_count: number;
  }>(
    'SELECT height, quorum_hash, total_magnitude, cpid_count, project_count FROM superblocks',
  );
  const envelopes: MeiliEnvelope[] = rows.map((r) => ({
    index: 'superblocks',
    action: 'upsert',
    doc: {
      id: String(r.height),
      height: Number(r.height),
      height_str: String(r.height),
      quorum_hash: r.quorum_hash,
      total_magnitude: Number(r.total_magnitude),
      cpid_count: Number(r.cpid_count),
      project_count: Number(r.project_count),
      projects: (projectsByHeight.get(Number(r.height)) ?? []).join(' '),
    },
  }));
  await flush(envelopes);
  return envelopes.length;
}

async function reindexPolls(): Promise<number> {
  const optRows = await query<{ poll_id: string; label: string }>(
    'SELECT poll_id, label FROM poll_options ORDER BY poll_id, idx',
  );
  const optionsByPoll = new Map<string, string[]>();
  for (const r of optRows) {
    const list = optionsByPoll.get(r.poll_id) ?? [];
    list.push(r.label);
    optionsByPoll.set(r.poll_id, list);
  }

  const rows = await query<{
    poll_id: string; title: string; question: string;
    response_type: string; weight_type: string;
    start_time: number | string | null; end_time: number | string | null;
  }>(
    `SELECT poll_id, title, question, response_type, weight_type,
            UNIX_TIMESTAMP(start_time) AS start_time,
            UNIX_TIMESTAMP(end_time)   AS end_time
     FROM polls`,
  );
  const envelopes: MeiliEnvelope[] = rows.map((r) => ({
    index: 'polls',
    action: 'upsert',
    doc: {
      id: r.poll_id,
      title: r.title,
      question: r.question,
      options: (optionsByPoll.get(r.poll_id) ?? []).join(' '),
      response_type: r.response_type,
      weight_type: r.weight_type,
      start_time: r.start_time === null ? null : Number(r.start_time),
      end_time: r.end_time === null ? null : Number(r.end_time),
    },
  }));
  await flush(envelopes);
  return envelopes.length;
}

async function reindexBeacons(): Promise<number> {
  const rows = await query<{
    cpid: string; tx_id: string; address: string; status: string; block_height: number;
    timestamp: number | string | null; expiration: number | string | null;
  }>(
    `SELECT cpid, tx_id, address, status, block_height,
            UNIX_TIMESTAMP(timestamp)  AS timestamp,
            UNIX_TIMESTAMP(expiration) AS expiration
     FROM beacons`,
  );
  // `_` join, not `:` — Meili rejects colons in document ids (see the
  // matching note in BlockWriter.buildMeiliEnvelopes).
  const envelopes: MeiliEnvelope[] = rows.map((r) => ({
    index: 'beacons',
    action: 'upsert',
    doc: {
      id: `${r.cpid}_${r.tx_id}`,
      cpid: r.cpid,
      address: r.address,
      status: r.status,
      block_height: Number(r.block_height),
      timestamp: r.timestamp === null ? null : Number(r.timestamp),
      expiration: r.expiration === null ? null : Number(r.expiration),
    },
  }));
  await flush(envelopes);
  return envelopes.length;
}

async function reindexMessages(): Promise<number> {
  const rows = await query<{
    tx_id: string; block_height: number; time: number | string | null; message: string;
  }>(
    'SELECT tx_id, block_height, UNIX_TIMESTAMP(time) AS time, message FROM tx_messages',
  );
  const envelopes: MeiliEnvelope[] = rows.map((r) => ({
    index: 'messages',
    action: 'upsert',
    doc: {
      id: r.tx_id,
      block_height: Number(r.block_height),
      time: r.time === null ? null : Number(r.time),
      message: r.message,
    },
  }));
  await flush(envelopes);
  return envelopes.length;
}

export async function reindexMeili(): Promise<number> {
  await clearIndices();
  const sb = await reindexSuperblocks();
  log.info(`reindexMeili: enqueued ${sb} superblock doc(s)`);
  const polls = await reindexPolls();
  log.info(`reindexMeili: enqueued ${polls} poll doc(s)`);
  const beacons = await reindexBeacons();
  log.info(`reindexMeili: enqueued ${beacons} beacon doc(s)`);
  const messages = await reindexMessages();
  log.info(`reindexMeili: enqueued ${messages} message doc(s)`);
  const total = sb + polls + beacons + messages;
  log.info(`reindexMeili: ${total} envelope(s) queued; the running MeiliIndexer drains meili:queue into the grc_explorer_mainnet_* indexes`);
  return total;
}

// CLI entrypoint — `node dist/scripts/reindexMeili.js`. Run while the
// explorer container is up so its MeiliIndexer consumes the stream.
if (require.main === module) {
  log.info('reindexMeili: starting');
  reindexMeili()
    .then(async () => { await closeRedis(); process.exit(0); })
    .catch(async (err) => {
      log.error('reindexMeili failed', err);
      await closeRedis();
      process.exit(1);
    });
}
