// Wipe explorer state — two modes:
//
//   FULL     (default)        — empties every chain-derived table, prunes
//                               Meili and the prefixed Redis namespace, and
//                               leaves the DuckDB database + schema in place
//                               so the next indexer boot walks from genesis.
//                               Mempool tables (`mempool_txs`,
//                               `mempool_snapshots`, `mrc_requests`) are
//                               preserved by default — they record events
//                               we observed live and can never reconstruct
//                               from chain alone. `--include-mempool` opts
//                               into emptying them too.
//                               BOINC name-mirror tables (`project_users`,
//                               `project_user_imports`) and the
//                               `cpid_names` Meili index are preserved by
//                               default for the same reason — re-fetching
//                               takes ~24h across the whitelist.
//                               `--include-boinc` opts into wiping them.
//
//   PARTIAL  (--from-height N) — surgical rewind: deletes every row with
//                               height >= N across all chain tables (the
//                               aggregate rollups are views, so they
//                               recompute on read), prunes Meili docs for
//                               those heights, rebuilds the address_state
//                               projection from the surviving
//                               address_balance_history rows, drops the meili:queue
//                               stream, and resets the cursor to N-1 so the
//                               HistoricalBackfiller picks up at exactly N.
//
// Both modes coordinate with a running indexer via the Redis wipe-lock:
// the lock is set first, every scheduled job (TipFollower, HistoricalBackfiller,
// MempoolWatcher, NetworkStatsPoller, MeiliIndexer, …) honors it and skips
// its next tick, the wipe waits until the cursor stops moving (so any
// in-flight batch finishes), then performs the destructive work. For the
// full wipe the lock lives in the prefixed Redis namespace, so the regular
// flush clears it on the way out. For the partial wipe we explicitly clear
// it at the end since the prefixed namespace survives.
//
// Usage:
//   docker exec grc_explorer npm run wipe                  # full wipe (preserves mempool + boinc)
//   docker exec grc_explorer npm run wipe -- --include-mempool
//   docker exec grc_explorer npm run wipe -- --include-boinc
//   docker exec grc_explorer npm run wipe -- --from-height 1234567
//   docker exec grc_explorer npm run wipe -- --help
//   # or, on the host with deps installed:
//   npm run wipe
//   npm run wipe -- --from-height 1234567

import { config } from '../config';
import { deleteChainRowsAtOrAboveHeight } from '../lib/chainTables';
import { query, run } from '../lib/db';
import { clearMeiliCursor, meili, MeiliIndexName } from '../lib/meili';
import {
  clearWipeLock, closeRedis, getCursor, redis, redisPrefix,
  setCursor, setWipeLock,
} from '../lib/redis';
import { rebuildAddressState } from './rebuildAddressState';

// Chain-derived Meili indexes — always wiped on a full reset.
// `addresses`, `cpid_names`, `blocks`, `transactions` and `claims`
// were dropped (see `lib/meili.ts`); kept out of this list so wipes
// don't try to delete from nonexistent indexes.
const CHAIN_MEILI_INDEXES: MeiliIndexName[] = [
  'superblocks', 'polls', 'beacons', 'messages',
];

// Off-chain BOINC enrichment used to live in a `cpid_names` Meili
// index, but the resolver was moved to CH `project_users` directly so
// there's no Meili-side state to wipe any more. List kept (empty) so
// the call sites that loop over it remain neutral.
const BOINC_MEILI_INDEXES: MeiliIndexName[] = [];

// CH tables that mirror off-chain BOINC user stats. Same opt-in
// semantics as the Meili index above.
const BOINC_CH_TABLES = ['project_users', 'project_user_imports'];

// Per-Meili-index spec for collecting doc IDs to drop. Each `idSql`
// returns one column `id` — the value is the Meili primary key for
// that index (see buildMeiliEnvelopes in BlockWriter).
const MEILI_HEIGHT_INDEXES: Array<{ name: MeiliIndexName; idSql: (h: number) => string }> = [
  { name: 'superblocks', idSql: (h) => `SELECT CAST(height AS VARCHAR) AS id FROM superblocks WHERE height >= ${h}` },
  { name: 'polls', idSql: (h) => `SELECT poll_id AS id FROM polls WHERE block_height >= ${h}` },
  { name: 'beacons', idSql: (h) => `SELECT concat(cpid, ':', tx_id) AS id FROM beacons WHERE block_height >= ${h}` },
  { name: 'messages', idSql: (h) => `SELECT tx_id AS id FROM tx_messages WHERE block_height >= ${h}` },
];

// The rollup tables (network_*, tx_*, claims_*, archive_*, difficulty_
// daily, stakers_daily, fee_quantiles_1h) are DuckDB VIEWs that recompute
// from the base tables on read — there is nothing to truncate or rebuild
// after a wipe, so the CH-era MV_REBUILDS table is gone.

// Tables we never wipe by default. Mempool/MRC events are observed
// live (first_seen, fee bid, eviction, MRC pending lifecycle) and can
// never be reconstructed from chain alone — losing them is permanent.
// BOINC name-mirror tables are preserved because re-fetching takes ~24h.
// The Kysely migration ledger is always preserved so the next boot
// doesn't replay every DDL. The preserved set is computed per-invocation
// from the
// opt-in flags: --include-mempool / --include-boinc move those tables
// back into the wipe (still DELETE FROM, not DROP — see wipeDatabaseFull).
interface FullWipeOpts {
  includeMempool: boolean;
  includeBoinc: boolean;
}

function preservedTables(opts: FullWipeOpts): Set<string> {
  // Kysely's migration bookkeeping tables — never wipe these or the boot
  // migrator would re-run every migration on a populated schema.
  const set = new Set(['kysely_migration', 'kysely_migration_lock']);
  if (!opts.includeMempool) {
    set.add('mempool_txs');
    set.add('mempool_snapshots');
    set.add('mrc_requests');
  }
  if (!opts.includeBoinc) {
    for (const t of BOINC_CH_TABLES) set.add(t);
  }
  return set;
}

async function wipeDatabaseFull(opts: FullWipeOpts): Promise<void> {
  const preserved = preservedTables(opts);
  // Empty every base table except the preserved set. The schema (and the
  // Kysely migration ledger) stays, so the next indexer boot's migrator is
  // a no-op and the indexer walks the chain from genesis. Rollup tables
  // are emptied too — RollupMaintainer rebuilds them as the backfill
  // re-crosses each bucket. (No DROP DATABASE: emptying the tables keeps
  // the carve-outs simple.)
  console.log(`→ DB: emptying every chain-derived table (preserving ${[...preserved].join(', ')})`);
  const tables = await query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`,
  );
  let cleared = 0;
  let skippedPreserved = 0;
  for (const t of tables) {
    if (preserved.has(t.name)) {
      skippedPreserved += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await run(`DELETE FROM ${t.name}`);
    cleared += 1;
  }
  console.log(`  emptied ${cleared} table(s), preserved ${skippedPreserved}`);
}

async function wipeRedisFull(): Promise<void> {
  console.log(`→ Redis: SCAN MATCH ${redisPrefix}*`);
  let cursor = '0';
  let removed = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${redisPrefix}*`, 'COUNT', 500);
    if (keys.length > 0) {
      // The redis client's keyPrefix would double-prefix the keys we
      // pass to DEL. Strip the prefix back off so the wire-side key
      // matches what's actually stored.
      const stripped = keys.map((k) => (k.startsWith(redisPrefix) ? k.slice(redisPrefix.length) : k));
      // eslint-disable-next-line no-await-in-loop
      await redis.del(...stripped);
      removed += stripped.length;
    }
    cursor = next;
  } while (cursor !== '0');
  console.log(`  ${removed} key(s) deleted`);
}

async function wipeMeiliFull(opts: FullWipeOpts): Promise<void> {
  const { includeBoinc } = opts;
  console.log(`→ Meili: DELETE indexes ${config.MEILI_INDEX_PREFIX}_*`);
  const targets = includeBoinc
    ? [...CHAIN_MEILI_INDEXES, ...BOINC_MEILI_INDEXES]
    : CHAIN_MEILI_INDEXES;
  for (const name of targets) {
    const id = `${config.MEILI_INDEX_PREFIX}_${name}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await meili.deleteIndex(id);
      console.log(`  dropped ${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Meili returns index_not_found for never-created indexes — fine.
      if (!/index_not_found|not found/i.test(msg)) {
        console.warn(`  ${id}: ${msg}`);
      }
    }
  }
}

async function wipeMeiliFromHeight(fromHeight: number): Promise<void> {
  // Per-index doc removal. We pull the IDs from the DB BEFORE deleting
  // any rows so the queries still see the to-be-orphaned doc set. Each
  // chunk is deleted in one round trip (Meili `deleteDocuments(ids)`).
  console.log(`→ Meili: deleting docs for height >= ${fromHeight}`);
  const CHUNK = 10_000;
  for (const ix of MEILI_HEIGHT_INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await query<{ id: string }>(ix.idSql(fromHeight));
    if (rows.length === 0) {
      console.log(`  ${ix.name}: no docs to remove`);
      continue;
    }
    const indexId = `${config.MEILI_INDEX_PREFIX}_${ix.name}`;
    let deleted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map((r) => r.id);
      try {
        // eslint-disable-next-line no-await-in-loop
        await meili.index(indexId).deleteDocuments(slice);
        deleted += slice.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/index_not_found|not found/i.test(msg)) break;
        throw err;
      }
    }
    console.log(`  ${ix.name}: removed ${deleted} doc(s)`);
  }
}

async function wipeDatabaseFromHeight(fromHeight: number): Promise<void> {
  console.log(`→ DB: deleting rows with height >= ${fromHeight}`);

  // Shared with the reorg rollback path (ChainReorgHandler) — one
  // canonical list of chain tables + height columns, incl. the
  // poll_options cascade through polls.
  await deleteChainRowsAtOrAboveHeight(fromHeight, (t) => {
    console.log(t === 'poll_options' ? '  poll_options: cascaded via polls' : `  ${t}: deleted >= ${fromHeight}`);
  });

  // Clear any deferred-annotation state on rows we kept that pointed at
  // rows we're now deleting. Currently only `polls`: PollWeightAggregator
  // sets av_w_balance/av_w_magnitude/weights_computed_at_height when a
  // poll closes; if those landed at height >= N, the surviving poll row
  // (block_height < N) carries stale aggregates that no longer reflect
  // the current chain state. Reset so the aggregator recomputes on the
  // next tick after backfill catches up.
  //
  await run(
    `UPDATE polls
       SET av_w_balance = NULL,
           av_w_magnitude = NULL,
           weights_computed_at_height = NULL
       WHERE weights_computed_at_height >= ${fromHeight}`,
  );
  console.log('  polls: cleared stale aggregator annotations');
  await run(
    `UPDATE votes
       SET weight = 0,
           weight_balance = 0,
           weight_magnitude = 0
       WHERE poll_id IN (
         SELECT poll_id FROM polls
         WHERE weights_computed_at_height IS NULL
           AND end_time <= now()
       )`,
  );
  console.log('  votes: cleared weights for re-aggregation');

  // The rollup views recompute from the (now-trimmed) base tables on
  // read, so there is nothing to rebuild after the deletes above.
}

async function rewindRedisToHeight(fromHeight: number): Promise<void> {
  console.log('→ rebuilding address_state projection from address_balance_history…');
  // address_state rows are running totals; we can't decrement back
  // surgically without replaying the deltas in reverse for every
  // affected address. Faster + simpler: truncate the projection and
  // re-aggregate the surviving deltas (rows with valid_from_height < N)
  // in one INSERT…SELECT — the same primitive the cold-start path uses.
  const replayed = await rebuildAddressState();
  console.log(`  projected ${replayed} addresses`);

  // Spent-UTXO state needs no rewind step: phantom detection reads
  // tx_inputs directly, and the wiped rows (>= N) are gone, so the
  // forward replay's re-spends resolve against the surviving (< N)
  // canonical spends automatically. (Retire any leftover Redis set
  // from the pre-DB-detection era.)
  await redis.del('utxo:spent');

  // Drop the meili:queue stream — pending envelopes for the deleted
  // height range would re-fire into Meili after the wipe lock clears,
  // re-creating the docs we just removed. The next backfill batch will
  // re-emit clean envelopes for >= N as it walks the chain. Keys are
  // auto-prefixed by the ioredis client; pass the unprefixed form.
  await redis.del('meili:queue');
  // Drop the persisted MeiliIndexer position too. If the indexer is
  // down during the wipe its run() wipe-branch never fires, so a stale
  // saved id would survive and, once the stream is reborn, point past
  // the new first entry — silently skipping post-wipe envelopes.
  await clearMeiliCursor();
  console.log('  meili:queue + cursor: dropped');

  // Reset the cursor to N-1 so the HistoricalBackfiller picks up at
  // exactly N. Pull the hash of N-1 from CH (rows < N survived the wipe);
  // genesis case (N === 0) deletes the cursor so backfill walks from 0.
  if (fromHeight === 0) {
    await redis.del('cursor');
    console.log('  cursor: deleted (next backfill walks from genesis)');
    return;
  }
  const rows = await query<{ hash: string }>(
    `SELECT hash FROM blocks WHERE height = ${fromHeight - 1} LIMIT 1`,
  );
  const hash = rows[0]?.hash;
  if (!hash) {
    throw new Error(
      `partial wipe: no surviving block at height ${fromHeight - 1}; `
      + 'refusing to leave cursor in inconsistent state',
    );
  }
  await setCursor({ height: fromHeight - 1, hash, status: 'backfilling' });
  console.log(`  cursor: set to height=${fromHeight - 1} status=backfilling`);
}

// Renew the wipe lock every `intervalMs` so it can't expire mid-wipe.
// The static TTL approach (set once, wait it out) is unsafe: real wipes
// — especially partial ones with 11 MV rebuilds across millions of rows
// + Meili paging — can outrun any conservative ceiling we'd pick, and
// once the TTL lapses the indexer wakes up and starts inserting while
// the wipe is still deleting. The heartbeat caps the worst-case "stuck
// lock after crash" window at `ttlSeconds` instead of unbounded; the
// wipe also calls `clearWipeLock()` on the happy path for instant
// resume.
function startWipeLockHeartbeat(intervalMs: number, ttlSeconds: number): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await setWipeLock(ttlSeconds);
    } catch (err) {
      // Redis hiccup — log and let the next tick try again. If Redis
      // is truly down the wipe has bigger problems than the lock.
      console.warn(`  wipe-lock heartbeat: renew failed (${(err as Error).message})`);
    }
  };
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

// Block until the indexer's cursor has stopped advancing for `requiredStableMs`,
// up to `timeoutMs`. Combined with the wipe-lock honored by every scheduled
// job, this guarantees no batch is mid-flight when the destructive work fires.
async function waitForIndexerQuiesce(
  requiredStableMs: number = 3000,
  timeoutMs: number = 30000,
  pollMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastHeight: number | null = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await getCursor();
    const h = cur?.height ?? null;
    if (lastHeight === null || h !== lastHeight) {
      lastHeight = h;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= requiredStableMs) {
      console.log(`  cursor stable at ${h ?? 'null'} for ${requiredStableMs}ms`);
      return;
    }
    process.stdout.write(`  cursor=${h ?? 'null'} stable=${Date.now() - stableSince}ms\r`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((r) => { setTimeout(r, pollMs); });
  }
  console.log('');
  console.warn('  warning: cursor never stabilised; proceeding anyway');
}

interface WipeArgs {
  fromHeight: number | null;
  includeMempool: boolean;
  includeBoinc: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`Usage: npm run wipe -- [options]

Wipes explorer state for the configured network (NETWORK=${config.NETWORK}).

Modes:
  (default)             Full wipe — empty every chain-derived table,
                        drop Meili chain indexes, clear the prefixed Redis
                        namespace. Schema stays; replay walks from genesis.
  --from-height N       Partial wipe — rewind to block N-1. Deletes rows
  --from N              with height >= N, prunes matching Meili docs, replays
                        Redis wallet projection from the survivors, resets
                        the cursor. Useful for surgical reorg recovery.

Opt-in carve-outs (preserved by default):
  --include-mempool     Also empty mempool_txs / mempool_snapshots /
                        mrc_requests.
  --include-boinc       Also drop project_users / project_user_imports
                        and the cpid_names Meili index. Re-fetching takes
                        a ~24h cycle across the project whitelist.

Other:
  -h, --help            Show this message and exit.

Examples:
  npm run wipe
  npm run wipe -- --include-mempool
  npm run wipe -- --include-boinc
  npm run wipe -- --include-mempool --include-boinc
  npm run wipe -- --from-height 1234567
`);
}

function parseArgs(argv: string[]): WipeArgs {
  let fromHeight: number | null = null;
  let includeMempool = false;
  let includeBoinc = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--from-height' || arg === '--from') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a numeric block height`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${arg}: expected non-negative integer, got "${value}"`);
      }
      fromHeight = n;
      i += 1;
    } else if (arg.startsWith('--from-height=') || arg.startsWith('--from=')) {
      const value = arg.split('=', 2)[1];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${arg}: expected non-negative integer, got "${value}"`);
      }
      fromHeight = n;
    } else if (arg === '--include-mempool') {
      includeMempool = true;
    } else if (arg === '--include-boinc') {
      includeBoinc = true;
    } else {
      throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
  }
  return {
    fromHeight, includeMempool, includeBoinc, help,
  };
}

export interface WipeRunOpts {
  fromHeight: number | null;
  includeMempool: boolean;
  includeBoinc: boolean;
}

// The destructive wipe work, run on the CURRENT process's DuckDB
// connection. The CALLER owns coordination (the wipe-lock / pausing the
// indexer). Used two ways: by the offline CLI below (app stopped), and
// by the in-process admin watcher (app live — it holds the DuckDB write
// lock, so a separate `npm run wipe` process can't, which is the whole
// reason the in-process path exists). See [[lib/adminTask]].
export async function runWipe(opts: WipeRunOpts): Promise<void> {
  if (opts.fromHeight === null) {
    const fullOpts: FullWipeOpts = { includeMempool: opts.includeMempool, includeBoinc: opts.includeBoinc };
    await wipeDatabaseFull(fullOpts);
    await wipeRedisFull();
    await wipeMeiliFull(fullOpts);
  } else {
    // Order: Meili IDs come from the DB, so collect+delete them BEFORE
    // we wipe the DB. Then base tables. Then Redis rewind (which reads
    // the surviving address_balance_history). Cursor reset at the end.
    await wipeMeiliFromHeight(opts.fromHeight);
    await wipeDatabaseFromHeight(opts.fromHeight);
    await rewindRedisToHeight(opts.fromHeight);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.fromHeight === null) {
    const preservedNotes: string[] = [];
    if (args.includeMempool) preservedNotes.push('mempool dropped');
    else preservedNotes.push('mempool preserved');
    if (args.includeBoinc) preservedNotes.push('boinc dropped');
    else preservedNotes.push('boinc preserved');
    console.log(`Wiping explorer state for network=${config.NETWORK} (${preservedNotes.join(', ')})`);
  } else {
    console.log(`Partial wipe (from height ${args.fromHeight}) for network=${config.NETWORK}`);
  }
  console.log(`  MariaDB:     ${config.DATABASE_URL}`);
  console.log(`  Redis:       ${config.REDIS_HOST}:${config.REDIS_PORT} prefix=${redisPrefix}`);
  console.log(`  Meili:       ${config.MEILI_HOST} prefix=${config.MEILI_INDEX_PREFIX}_*`);
  console.log('');

  // The lock is renewed by a heartbeat (see below). Set a short TTL so
  // a crashed wipe self-clears in ~2 minutes instead of blocking the
  // indexer for half an hour; the heartbeat keeps the live wipe safe
  // for as long as it needs to run.
  const lockTtl = 120;
  const heartbeatInterval = 30_000;
  console.log(`→ Acquiring wipe lock (TTL ${lockTtl}s, renew every ${heartbeatInterval / 1000}s)…`);
  await setWipeLock(lockTtl);
  const stopHeartbeat = startWipeLockHeartbeat(heartbeatInterval, lockTtl);
  try {
    console.log('→ Waiting for indexer to quiesce…');
    await waitForIndexerQuiesce();
    console.log('');

    await runWipe({
      fromHeight: args.fromHeight,
      includeMempool: args.includeMempool,
      includeBoinc: args.includeBoinc,
    });
    // Full wipe's Redis flush already removed the lock; the partial wipe
    // leaves the namespace intact, so clear it explicitly (idempotent)
    // — otherwise scheduled jobs idle until the TTL expires before
    // resuming.
    await clearWipeLock();
  } finally {
    stopHeartbeat();
  }

  // Close every Redis socket so node can exit cleanly — otherwise the
  // process hangs on the sockets lib/redis opens eagerly at import.
  await closeRedis();

  console.log('');
  if (args.fromHeight === null) {
    console.log('done. start grc_explorer to begin replay from genesis.');
  } else {
    console.log(`done. backfiller will resume at height ${args.fromHeight}.`);
  }
}

// Only run the CLI when invoked directly (`node dist/scripts/wipeExplorer.js`,
// app stopped). Importing this module (e.g. the admin watcher pulling in
// `runWipe`) must NOT kick off the CLI.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
