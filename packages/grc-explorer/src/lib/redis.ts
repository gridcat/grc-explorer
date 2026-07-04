import Redis from 'ioredis';
import { config } from '../config';

const baseOpts = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  keyPrefix: `${config.REDIS_PREFIX}:`,
  // Don't crash on transient outages; let the breaker + retry handle it.
  maxRetriesPerRequest: 3,
};

// Pub/sub clients must NOT carry a keyPrefix. ioredis applies the
// prefix to channel arguments on publish/(p)subscribe too, which would
// double-prefix every fanout channel when the indexer publishes and
// the api psubscribes — the wire channel ends up
// `grc-explorer:mainnet:grc-explorer:mainnet:events:block.new` and the
// subscriber's `channel.slice(CHANNEL_PREFIX.length)` then strips only
// one of those prefixes, so events.emit() lands on a topic name no
// SSE client is listening for. fanout.ts already namespaces channels
// explicitly via CHANNEL_PREFIX, so opt these clients out.
const pubsubOpts = { ...baseOpts, keyPrefix: undefined };

// Logical clients. ioredis requires separate connections for blocking
// commands (XREAD) and pub/sub (subscribe), so we share a "command"
// client for normal ops and dedicated ones for streams / pub/sub.
// Each is created lazily on first import.
export const redis = new Redis(baseOpts);
export const redisStreams = new Redis(baseOpts);
export const redisSub = new Redis(pubsubOpts);
export const redisPub = new Redis(pubsubOpts);

// Keys aren't auto-prefixed when used inside Lua / pub/sub channel
// names; export the prefix so callers can compose keys explicitly when
// needed.
export const redisPrefix = `${config.REDIS_PREFIX}:`;

// Close every socket opened above so a one-shot CLI script can exit
// cleanly (the four clients are created eagerly at import). lib/redis
// owns the sockets, so it owns the teardown — shared by the wipe /
// boinc:fetch / admin scripts instead of each repeating the quit dance.
export async function closeRedis(): Promise<void> {
  await Promise.all([redis.quit(), redisStreams.quit(), redisSub.quit(), redisPub.quit()]);
}

// Monotonic sequence counter used as the `_seq` version on every CH
// row that may be re-inserted (reorgs, deferred annotations).
// ReplacingMergeTree(_seq) merges away older versions; argMax(…, _seq)
// at read time picks the latest. One global counter is the simplest
// reasoning model — per-table counters parallelise slightly better but
// muddle the "newer write wins" invariant across joins.
export async function nextSeq(): Promise<bigint> {
  return BigInt(await redis.incr('seq'));
}

// Indexer cursor mirror. The real source of truth is whatever CH says
// when you SELECT max(height) FROM blocks, but a Redis copy lets every
// reader (API, frontend SSE consumers) skip the round-trip on the hot
// path. Updated by the indexer after each successful block-write.
export interface IndexerCursor {
  height: number;
  hash: string;
  status: 'live' | 'backfilling' | 'reorg';
  updatedAt: number;
}

export async function getCursor(): Promise<IndexerCursor | null> {
  const raw = await redis.hgetall('cursor');
  if (!raw.height) return null;
  return {
    height: Number(raw.height),
    hash: raw.hash,
    status: raw.status as IndexerCursor['status'],
    updatedAt: Number(raw.updatedAt),
  };
}

export async function setCursor(c: Omit<IndexerCursor, 'updatedAt'>): Promise<void> {
  await redis.hset('cursor', {
    height: c.height,
    hash: c.hash,
    status: c.status,
    updatedAt: Date.now(),
  });
}

// Wipe coordination. The wipe script can't trust the operator to stop
// grc_explorer first (the canonical invocation `docker exec grc_explorer
// npm run wipe` requires the container running, so "stop first" is a
// non-starter). Setting this key tells every scheduled job to skip its
// next tick; the wipe waits for the cursor to stabilise (so any
// in-flight batch finishes), then drops the database. The key lives
// inside the prefixed namespace, so `wipeRedis` itself clears the
// lock as part of the regular flush — once the wipe completes, jobs
// resume on their next interval.
export const WIPE_LOCK_KEY = 'wipe:lock';

export async function isWipeInProgress(): Promise<boolean> {
  return (await redis.get(WIPE_LOCK_KEY)) !== null;
}

export async function setWipeLock(ttlSeconds: number = 120): Promise<void> {
  await redis.set(WIPE_LOCK_KEY, '1', 'EX', ttlSeconds);
}

export async function clearWipeLock(): Promise<void> {
  await redis.del(WIPE_LOCK_KEY);
}

// DuckDB secondary-index self-heal flag. When a write path hits the fatal
// "Failed to delete all rows from index" corruption, the whole database is
// invalidated and the only recovery is to reopen it — but the dangling ART
// index entries are persisted on disk, so a plain restart would crash-loop
// on the next delete. The fatal handler sets this flag before exiting; the
// next boot rebuilds the secondary indexes (clearing the dangling entries)
// and clears it. Survives the restart by design, so it lives outside the
// wipe-flush namespace.
export const INDEX_REBUILD_KEY = 'duckdb:index-rebuild-needed';

export async function isIndexRebuildNeeded(): Promise<boolean> {
  return (await redis.get(INDEX_REBUILD_KEY)) !== null;
}

export async function setIndexRebuildNeeded(): Promise<void> {
  await redis.set(INDEX_REBUILD_KEY, '1');
}

export async function clearIndexRebuildNeeded(): Promise<void> {
  await redis.del(INDEX_REBUILD_KEY);
}

// Wallet current-state projection moved to MariaDB (lib/addressState,
// `address_state` table, migration 0007). The Redis copy — wallet:{addr}
// HSETs + wallets:by_balance / by_last_seen ZSETs — had grown to ~2.9 GB,
// bigger than the whole prod RAM envelope. One-off key cleanup after
// deploying the cutover:
//   redis-cli --scan --pattern '<prefix>:wallet:*' | xargs -L 500 redis-cli del
//   redis-cli del <prefix>:wallets:by_balance <prefix>:wallets:by_last_seen
