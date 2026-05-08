// Wipe explorer state — two modes:
//
//   FULL     (default)        — TRUNCATEs every chain-derived table, prunes
//                               Meili and the prefixed Redis namespace, and
//                               leaves the CH database + schema in place so
//                               the next indexer boot walks from genesis.
//                               Mempool tables (`mempool_txs`,
//                               `mempool_snapshots`, `mrc_requests`) are
//                               preserved by default — they record events
//                               we observed live and can never reconstruct
//                               from chain alone. `--include-mempool` opts
//                               into the historical DROP DATABASE behaviour.
//
//   PARTIAL  (--from-height N) — surgical rewind: deletes every CH row with
//                               height >= N (across all chain tables and
//                               their aggregate MVs), prunes Meili docs for
//                               those heights, rewinds the Redis wallet
//                               projection by replaying address_balance_history
//                               from the surviving rows, drops the meili:queue
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
//   docker exec grc_explorer npm run wipe                  # full wipe (preserves mempool)
//   docker exec grc_explorer npm run wipe -- --include-mempool
//   docker exec grc_explorer npm run wipe -- --from-height 1234567
//   # or, on the host with deps installed:
//   npm run wipe
//   npm run wipe -- --from-height 1234567

import { config } from '../config';
import { meili, MeiliIndexName } from '../lib/meili';
import {
  clearWipeLock, getCursor, redis, redisPrefix, redisStreams, redisSub, redisPub,
  setCursor, setWipeLock,
} from '../lib/redis';
import { rebuildWallets } from './rebuildWallets';

const CH_URL = config.CLICKHOUSE_URL.replace(/\/$/, '');
const CH_DB = config.CLICKHOUSE_DATABASE;

const ALL_MEILI_INDEXES: MeiliIndexName[] = [
  'blocks', 'transactions', 'addresses', 'claims',
  'superblocks', 'polls', 'beacons', 'messages',
];

// Block-height-bearing CH tables. Order matters for `poll_options`
// (which has no height column of its own and must be cascaded via a
// subquery against `polls` BEFORE we delete from `polls` itself).
const HEIGHT_TABLES: Array<{ table: string; column: string }> = [
  { table: 'blocks', column: 'height' },
  { table: 'transactions', column: 'block_height' },
  { table: 'tx_outputs', column: 'block_height' },
  { table: 'tx_inputs', column: 'block_height' },
  { table: 'address_balance_history', column: 'valid_from_height' },
  { table: 'tx_messages', column: 'block_height' },
  { table: 'claims', column: 'block_height' },
  { table: 'claim_mrcs', column: 'block_height' },
  { table: 'superblocks', column: 'height' },
  { table: 'superblock_magnitudes', column: 'superblock_height' },
  { table: 'superblock_projects', column: 'superblock_height' },
  { table: 'beacons', column: 'block_height' },
  { table: 'polls', column: 'block_height' },
  { table: 'votes', column: 'block_height' },
  { table: 'project_contracts', column: 'block_height' },
];

// Per-Meili-index spec for collecting doc IDs to drop. Each `idSql`
// returns one column `id` — the value is the Meili primary key for
// that index (see buildMeiliEnvelopes in BlockWriter).
const MEILI_HEIGHT_INDEXES: Array<{ name: MeiliIndexName; idSql: (h: number) => string }> = [
  { name: 'blocks', idSql: (h) => `SELECT toString(height) AS id FROM blocks WHERE height >= ${h}` },
  { name: 'transactions', idSql: (h) => `SELECT tx_id AS id FROM transactions WHERE block_height >= ${h}` },
  { name: 'claims', idSql: (h) => `SELECT toString(block_height) AS id FROM claims WHERE block_height >= ${h}` },
  { name: 'superblocks', idSql: (h) => `SELECT toString(height) AS id FROM superblocks WHERE height >= ${h}` },
  { name: 'polls', idSql: (h) => `SELECT poll_id AS id FROM polls WHERE block_height >= ${h}` },
  { name: 'beacons', idSql: (h) => `SELECT concat(cpid, ':', tx_id) AS id FROM beacons WHERE block_height >= ${h}` },
  { name: 'messages', idSql: (h) => `SELECT tx_id AS id FROM tx_messages WHERE block_height >= ${h}` },
];

// Aggregate MVs that bucket their base table by chain time, NOT block
// height. Partial wipes can't filter these by height directly — base-table
// rows >= N are gone, but the partial sums in the MV survive (MV triggers
// only fire on INSERT). TRUNCATE + re-INSERT from the now-trimmed base
// is the simplest correct rebuild; mirrors the strategy migration 0006
// already uses for the archive_* MVs.
const MV_REBUILDS: Array<{ name: string; selectSql: string }> = [
  {
    name: 'network_5m',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 300) * 300) AS bucket_ts,
      count()       AS block_count,
      sum(tx_count) AS tx_count,
      sum(mint)     AS mint_total,
      sum(size)     AS bytes_total
    FROM blocks GROUP BY bucket_ts`,
  },
  {
    name: 'network_1h',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
      count()       AS block_count,
      sum(tx_count) AS tx_count,
      sum(mint)     AS mint_total,
      sum(size)     AS bytes_total
    FROM blocks GROUP BY bucket_ts`,
  },
  {
    name: 'network_1d',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 86400) * 86400) AS bucket_ts,
      count()       AS block_count,
      sum(tx_count) AS tx_count,
      sum(mint)     AS mint_total,
      sum(size)     AS bytes_total
    FROM blocks GROUP BY bucket_ts`,
  },
  {
    name: 'fee_quantiles_1h',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
      quantilesTDigestState(0.5, 0.95, 0.99)(fee * 1024 / size) AS quantile_state,
      countState() AS tx_count_state
    FROM transactions
    WHERE NOT is_coinbase AND NOT is_coinstake AND fee > 0 AND size > 0
    GROUP BY bucket_ts`,
  },
  {
    name: 'tx_5m',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 300) * 300) AS bucket_ts,
      sum(total_out) AS value_moved,
      sum(fee)       AS fee_total
    FROM transactions
    WHERE NOT is_coinbase AND NOT is_coinstake
    GROUP BY bucket_ts`,
  },
  {
    name: 'tx_1h',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(time), 3600) * 3600) AS bucket_ts,
      sum(total_out) AS value_moved,
      sum(fee)       AS fee_total
    FROM transactions
    WHERE NOT is_coinbase AND NOT is_coinstake
    GROUP BY bucket_ts`,
  },
  {
    name: 'claims_5m',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(block_time), 300) * 300) AS bucket_ts,
      sum(research_subsidy) AS research_subsidy_total,
      sum(block_subsidy)    AS block_subsidy_total
    FROM claims
    WHERE block_time > toDateTime(0)
    GROUP BY bucket_ts`,
  },
  {
    name: 'claims_1h',
    selectSql: `SELECT
      toUInt32(intDiv(toUInt32(block_time), 3600) * 3600) AS bucket_ts,
      sum(research_subsidy) AS research_subsidy_total,
      sum(block_subsidy)    AS block_subsidy_total
    FROM claims
    WHERE block_time > toDateTime(0)
    GROUP BY bucket_ts`,
  },
  {
    name: 'archive_blocks_daily',
    selectSql: `SELECT
      toDate(time)           AS bucket_date,
      count()                AS block_count,
      sum(tx_count)          AS tx_count,
      sum(mint)              AS mint_total,
      sum(size)              AS bytes_total,
      countIf(is_pos)        AS pos_count,
      countIf(is_superblock) AS superblock_count
    FROM blocks GROUP BY bucket_date`,
  },
  {
    name: 'archive_txs_daily',
    selectSql: `SELECT
      toDate(time)   AS bucket_date,
      sum(total_out) AS value_moved,
      sum(fee)       AS fee_total,
      count()        AS user_tx_count
    FROM transactions
    WHERE NOT is_coinbase AND NOT is_coinstake
    GROUP BY bucket_date`,
  },
  {
    name: 'archive_minters_daily',
    selectSql: `SELECT
      toDate(time)             AS bucket_date,
      uniqState(miner_address) AS miners_uniq,
      uniqState(staker_cpid)   AS stakers_uniq
    FROM blocks GROUP BY bucket_date`,
  },
  {
    name: 'difficulty_daily',
    selectSql: `SELECT
      toDate(time)                    AS bucket_date,
      minState(difficulty)            AS difficulty_min,
      maxState(difficulty)            AS difficulty_max,
      sumState(toFloat64(difficulty)) AS difficulty_sum,
      countState()                    AS difficulty_count,
      argMinState(difficulty, height) AS difficulty_open,
      argMaxState(difficulty, height) AS difficulty_close
    FROM blocks GROUP BY bucket_date`,
  },
  {
    name: 'stakers_daily',
    selectSql: `SELECT
      toDate(time)                                        AS bucket_date,
      uniqIfState(miner_address, staker_cpid IS NOT NULL) AS researcher_stakers,
      uniqIfState(miner_address, staker_cpid IS NULL)     AS investor_stakers,
      uniqState(miner_address)                            AS total_stakers,
      sumState(toUInt64(mint))                            AS mint_sum,
      countState()                                        AS pos_blocks
    FROM blocks WHERE is_pos GROUP BY bucket_date`,
  },
];

async function chPost(
  sql: string,
  opts: { withDb?: boolean; settings?: Record<string, string> } = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (opts.withDb !== false) params.set('database', CH_DB);
  for (const [k, v] of Object.entries(opts.settings ?? {})) params.set(k, v);
  const res = await fetch(`${CH_URL}/?${params.toString()}`, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).trim()}`);
  return res.text();
}

async function chQueryJson<T>(sql: string): Promise<T[]> {
  const params = new URLSearchParams();
  params.set('database', CH_DB);
  params.set('default_format', 'JSONEachRow');
  const res = await fetch(`${CH_URL}/?${params.toString()}`, {
    method: 'POST',
    body: sql,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).trim()}`);
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

// Synchronous mutation: ALTER TABLE … DELETE/UPDATE returns immediately
// otherwise. mutations_sync=2 makes the request block until the mutation
// merges land, so the script's next step sees a clean table.
const SYNC_MUTATION = { mutations_sync: '2' };

// Tables we never wipe by default. Mempool/MRC events are observed
// live (first_seen, fee bid, eviction, MRC pending lifecycle) and can
// never be reconstructed from chain alone — losing them is permanent.
// `_migrations` stays so we don't replay every DDL on the next boot.
// `--include-mempool` overrides this set and falls back to DROP DATABASE.
const PRESERVED_TABLES = new Set([
  'mempool_txs',
  'mempool_snapshots',
  'mrc_requests',
  '_migrations',
]);

async function wipeClickhouseFull(includeMempool: boolean): Promise<void> {
  if (includeMempool) {
    console.log(`→ CH: DROP DATABASE IF EXISTS ${CH_DB} (--include-mempool: full nuke)`);
    await chPost(`DROP DATABASE IF EXISTS ${CH_DB}`, { withDb: false });
    console.log('→ CH: re-running migrations…');
    // Defer to migrate.mjs by spawning it through node — no transitive
    // dependency on its internals beyond exit code.
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [`${__dirname}/../../clickhouse/migrate.mjs`],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          CLICKHOUSE_URL: CH_URL,
          CLICKHOUSE_DATABASE: CH_DB,
        },
      },
    );
    if (result.status !== 0) throw new Error(`migrate.mjs exited ${result.status}`);
    return;
  }

  // Default: TRUNCATE every table except the preserved set. Materialised
  // views (engine = MaterializedView) wrap underlying *_inner / *_target
  // storage and can't be TRUNCATEd directly — the engine name `Materialized*`
  // covers their backing tables which DO support TRUNCATE.
  console.log(`→ CH: TRUNCATE every chain-derived table (preserving ${[...PRESERVED_TABLES].join(', ')})`);
  const tables = await chQueryJson<{ name: string; engine: string }>(
    `SELECT name, engine FROM system.tables WHERE database = '${CH_DB}' AND NOT is_temporary`,
  );
  let truncated = 0;
  let skippedPreserved = 0;
  let skippedView = 0;
  for (const t of tables) {
    if (PRESERVED_TABLES.has(t.name)) {
      skippedPreserved += 1;
      continue;
    }
    if (t.engine === 'MaterializedView') {
      // Backing storage gets TRUNCATEd via the underlying *_inner table
      // CH auto-creates; the view itself is just a query against it.
      skippedView += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await chPost(`TRUNCATE TABLE ${t.name}`);
    truncated += 1;
  }
  console.log(
    `  truncated ${truncated} table(s), preserved ${skippedPreserved}, skipped ${skippedView} view(s)`,
  );
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

async function wipeMeiliFull(): Promise<void> {
  console.log(`→ Meili: DELETE indexes ${config.MEILI_INDEX_PREFIX}_*`);
  for (const name of ALL_MEILI_INDEXES) {
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
  // Per-index doc removal. We pull the IDs from CH BEFORE deleting any
  // CH rows so the queries still see the to-be-orphaned doc set. Each
  // chunk is deleted in one round trip (Meili `deleteDocuments(ids)`).
  console.log(`→ Meili: deleting docs for height >= ${fromHeight}`);
  const CHUNK = 10_000;
  for (const ix of MEILI_HEIGHT_INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await chQueryJson<{ id: string }>(ix.idSql(fromHeight));
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

async function wipeClickhouseFromHeight(fromHeight: number): Promise<void> {
  console.log(`→ CH: deleting rows with height >= ${fromHeight}`);

  // poll_options has no height column; cascade through polls FIRST,
  // before the polls table loses the rows the subquery needs.
  await chPost(
    `ALTER TABLE poll_options DELETE
       WHERE poll_id IN (SELECT poll_id FROM polls WHERE block_height >= ${fromHeight})`,
    { settings: SYNC_MUTATION },
  );
  console.log('  poll_options: cascaded via polls');

  for (const t of HEIGHT_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await chPost(
      `ALTER TABLE ${t.table} DELETE WHERE ${t.column} >= ${fromHeight}`,
      { settings: SYNC_MUTATION },
    );
    console.log(`  ${t.table}: deleted >= ${fromHeight}`);
  }

  // Clear any deferred-annotation state on rows we kept that pointed at
  // rows we're now deleting. Currently only `polls`: PollWeightAggregator
  // sets av_w_balance/av_w_magnitude/weights_computed_at_height when a
  // poll closes; if those landed at height >= N, the surviving poll row
  // (block_height < N) carries stale aggregates that no longer reflect
  // the current chain state. Reset so the aggregator recomputes on the
  // next tick after backfill catches up.
  //
  // CH ALTER UPDATE on ReplacingMergeTree(_seq) emits new versions that
  // supersede the old at merge time; FINAL queries see the cleared state
  // immediately.
  await chPost(
    `ALTER TABLE polls
       UPDATE av_w_balance = NULL,
              av_w_magnitude = NULL,
              weights_computed_at_height = NULL
       WHERE weights_computed_at_height >= ${fromHeight}`,
    { settings: SYNC_MUTATION },
  );
  console.log('  polls: cleared stale aggregator annotations');
  await chPost(
    `ALTER TABLE votes
       UPDATE weight = 0,
              weight_balance = 0,
              weight_magnitude = 0
       WHERE poll_id IN (
         SELECT poll_id FROM polls FINAL
         WHERE weights_computed_at_height IS NULL
           AND end_time <= now()
       )`,
    { settings: SYNC_MUTATION },
  );
  console.log('  votes: cleared weights for re-aggregation');

  // Aggregate MVs are SummingMergeTree / AggregatingMergeTree on the
  // base tables — their triggers only fire on INSERT, so DELETEs above
  // never reached them. Rebuild from the now-trimmed bases.
  //
  // `max_partitions_per_insert_block=0` disables the per-INSERT
  // partition-fanout guard: the rebuild SELECTs span the entire chain
  // history and a fine-grained MV like `archive_blocks_daily`
  // (toDate(time) → ~2K partitions across 5+ years of testnet) blows
  // through the default 100 limit otherwise. The guard is a foot-gun
  // for streaming inserts; for one-shot rebuilds it just gets in the
  // way. CH still merges the resulting parts correctly afterwards.
  console.log('→ CH: rebuilding aggregate materialized views…');
  for (const mv of MV_REBUILDS) {
    // eslint-disable-next-line no-await-in-loop
    await chPost(`TRUNCATE TABLE ${mv.name}`);
    // eslint-disable-next-line no-await-in-loop
    await chPost(
      `INSERT INTO ${mv.name} ${mv.selectSql}`,
      { settings: { max_partitions_per_insert_block: '0' } },
    );
    console.log(`  ${mv.name}: rebuilt`);
  }
}

async function rewindRedisToHeight(fromHeight: number): Promise<void> {
  console.log('→ Redis: rebuilding wallet projection from address_balance_history…');
  // The wallet HSETs are running totals; we can't decrement back
  // surgically without replaying the deltas in reverse for every
  // affected address. Faster + simpler: clear all wallet keys + ZSETs
  // and replay the surviving deltas (rows with valid_from_height < N).
  // Same primitive `rebuildWallets` already exposes for the cold-start
  // path; the trimmed CH event log is exactly what we need.
  const replayed = await rebuildWallets();
  console.log(`  replayed ${replayed} delta rows`);

  // Drop the meili:queue stream — pending envelopes for the deleted
  // height range would re-fire into Meili after the wipe lock clears,
  // re-creating the docs we just removed. The next backfill batch will
  // re-emit clean envelopes for >= N as it walks the chain. Keys are
  // auto-prefixed by the ioredis client; pass the unprefixed form.
  await redis.del('meili:queue');
  console.log('  meili:queue: dropped');

  // Reset the cursor to N-1 so the HistoricalBackfiller picks up at
  // exactly N. Pull the hash of N-1 from CH (rows < N survived the wipe);
  // genesis case (N === 0) deletes the cursor so backfill walks from 0.
  if (fromHeight === 0) {
    await redis.del('cursor');
    console.log('  cursor: deleted (next backfill walks from genesis)');
    return;
  }
  const rows = await chQueryJson<{ hash: string }>(
    `SELECT hash FROM blocks FINAL WHERE height = ${fromHeight - 1} LIMIT 1`,
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
}

function parseArgs(argv: string[]): WipeArgs {
  let fromHeight: number | null = null;
  let includeMempool = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-height' || arg === '--from') {
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
    }
  }
  return { fromHeight, includeMempool };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.fromHeight === null) {
    const note = args.includeMempool ? ' (including mempool — full nuke)' : ' (preserving mempool)';
    console.log(`Wiping explorer state for network=${config.NETWORK}${note}`);
  } else {
    console.log(`Partial wipe (from height ${args.fromHeight}) for network=${config.NETWORK}`);
  }
  console.log(`  ClickHouse:  ${CH_URL}/${CH_DB}`);
  console.log(`  Redis:       ${config.REDIS_HOST}:${config.REDIS_PORT} prefix=${redisPrefix}`);
  console.log(`  Meili:       ${config.MEILI_HOST} prefix=${config.MEILI_INDEX_PREFIX}_*`);
  console.log('');

  // Partial wipes do far more CH work (multiple ALTER TABLE DELETEs on
  // tables that may carry millions of rows, plus 11 MV rebuilds) than
  // a full wipe's single DROP DATABASE. Lift the lock TTL accordingly
  // so the indexer can't re-enter mid-rewrite if a delete drags.
  const lockTtl = args.fromHeight === null ? 120 : 1800;
  console.log(`→ Acquiring wipe lock (TTL ${lockTtl}s)…`);
  await setWipeLock(lockTtl);
  console.log('→ Waiting for indexer to quiesce…');
  await waitForIndexerQuiesce();
  console.log('');

  if (args.fromHeight === null) {
    await wipeClickhouseFull(args.includeMempool);
    await wipeRedisFull();
    await wipeMeiliFull();
  } else {
    // Order: Meili IDs come from CH, so collect+delete them BEFORE we
    // wipe CH. Then CH base tables. Then Redis rewind (which reads the
    // surviving address_balance_history). Cursor reset at the end.
    await wipeMeiliFromHeight(args.fromHeight);
    await wipeClickhouseFromHeight(args.fromHeight);
    await rewindRedisToHeight(args.fromHeight);
    // Full wipe drops the prefixed namespace which removes the lock
    // along the way. Partial wipe leaves the namespace intact, so we
    // explicitly clear the lock here — otherwise scheduled jobs idle
    // until the TTL expires before resuming.
    await clearWipeLock();
  }

  // Close every Redis connection lib/redis.ts opened so node can exit
  // cleanly. Without these `quit()` calls the process hangs on the
  // four ioredis sockets the lib eagerly opens at import time.
  await Promise.all([
    redis.quit(),
    redisStreams.quit(),
    redisSub.quit(),
    redisPub.quit(),
  ]);

  console.log('');
  if (args.fromHeight === null) {
    console.log('done. start grc_explorer to begin replay from genesis.');
  } else {
    console.log(`done. backfiller will resume at height ${args.fromHeight}.`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
