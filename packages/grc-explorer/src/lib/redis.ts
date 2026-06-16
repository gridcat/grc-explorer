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

// Wallet projection — Redis is the canonical store for "current
// balance per address." The CH `address_balance_history` table is the
// immutable event log; on cold start `rebuildWallets` walks it and
// re-applies into Redis here.
//
// Keys:
//   wallet:{addr}        HSET — { balance, total_received, total_sent,
//                                 tx_count, first_seen_block, last_seen_block }
//   wallets:by_balance   ZSET (score=balance halford, member=address)
//   wallets:by_last_seen ZSET (score=block_height,   member=address)
//
// Halford bigints up to ~9e15 (2^53) survive JavaScript Number /
// Redis ZADD-score precision losslessly. Gridcoin's 500 M GRC supply
// = 5 × 10^16 halford — at the very top of supply we exceed 2^53 by
// roughly 5×, so ZSET scores for whales-holding-the-full-supply may
// be approximate. Ranking still correct; precise balance comes from
// HSET (which stores the exact integer string).

export interface WalletState {
  address: string;
  balance: bigint;
  totalReceived: bigint;
  totalSent: bigint;
  txCount: number;
  firstSeenBlock: number | null;
  lastSeenBlock: number | null;
}

const walletKey = (addr: string): string => `wallet:${addr}`;
const BY_BALANCE = 'wallets:by_balance';
const BY_LAST_SEEN = 'wallets:by_last_seen';

function readWalletHash(address: string, raw: Record<string, string>): WalletState | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    address,
    balance: BigInt(raw.balance ?? '0'),
    totalReceived: BigInt(raw.total_received ?? '0'),
    totalSent: BigInt(raw.total_sent ?? '0'),
    txCount: Number(raw.tx_count ?? '0'),
    firstSeenBlock: raw.first_seen_block ? Number(raw.first_seen_block) : null,
    lastSeenBlock: raw.last_seen_block ? Number(raw.last_seen_block) : null,
  };
}

export interface WalletDelta {
  address: string;
  delta: bigint;
  received: bigint;
  sent: bigint;
  txCountDelta: number;
  height: number;
}

/**
 * Batched wallet projection update — collapses every (address, block)
 * delta in an applyBlocks call into ONE Redis pipeline round trip.
 *
 * Per-address aggregation: same address appearing in N blocks of the
 * batch becomes one summed HINCRBY + one ZINCRBY, instead of N pairs
 * of round trips. ZINCRBY in place of "ZADD newBalance" lets the rich-
 * list score increment by the delta directly, so no reply-and-wait
 * dependency exists between commands — every command for every
 * address ships in a single pipeline.
 *
 * Score precision is unchanged: per-block deltas live well below 2^53
 * halford. The whale caveat (canonical balance read from HSET, not
 * the ZSET score) carries over from `applyWalletDelta`.
 */
export async function applyWalletDeltasBatch(deltas: WalletDelta[]): Promise<void> {
  if (deltas.length === 0) return;

  type Agg = {
    delta: bigint; received: bigint; sent: bigint;
    txCountDelta: number; firstHeight: number; lastHeight: number;
  };
  const agg = new Map<string, Agg>();
  for (const d of deltas) {
    const found = agg.get(d.address);
    if (found) {
      found.delta += d.delta;
      found.received += d.received;
      found.sent += d.sent;
      found.txCountDelta += d.txCountDelta;
      if (d.height < found.firstHeight) found.firstHeight = d.height;
      if (d.height > found.lastHeight) found.lastHeight = d.height;
    } else {
      agg.set(d.address, {
        delta: d.delta,
        received: d.received,
        sent: d.sent,
        txCountDelta: d.txCountDelta,
        firstHeight: d.height,
        lastHeight: d.height,
      });
    }
  }

  const pipe = redis.pipeline();
  for (const [address, a] of agg) {
    const key = walletKey(address);
    pipe.hincrby(key, 'balance', a.delta.toString() as unknown as number);
    pipe.hincrby(key, 'total_received', a.received.toString() as unknown as number);
    pipe.hincrby(key, 'total_sent', a.sent.toString() as unknown as number);
    pipe.hincrby(key, 'tx_count', a.txCountDelta);
    pipe.hsetnx(key, 'first_seen_block', String(a.firstHeight));
    pipe.hset(key, 'last_seen_block', String(a.lastHeight));
    pipe.zincrby(BY_BALANCE, Number(a.delta), address);
    pipe.zadd(BY_LAST_SEEN, a.lastHeight, address);
  }
  await pipe.exec();
}

// Apply a per-block delta to one address. Pipelined HINCRBYs return
// the post-increment values; the new balance is read off the first
// reply and used to ZADD the by-balance index in a second hop.
//
// Prefer `applyWalletDeltasBatch` from the indexer hot path. This
// single-address variant stays for the rebuildWallets script (one-off
// rebuild from CH event log, no batching pressure).
export async function applyWalletDelta(
  address: string,
  delta: bigint,
  received: bigint,
  sent: bigint,
  txCountDelta: number,
  height: number,
): Promise<bigint> {
  const key = walletKey(address);
  const pipe = redis.pipeline();
  // hincrby's third arg signature is `number | string`; passing the
  // BigInt's string form keeps full integer precision over the wire.
  pipe.hincrby(key, 'balance', delta.toString() as unknown as number);
  pipe.hincrby(key, 'total_received', received.toString() as unknown as number);
  pipe.hincrby(key, 'total_sent', sent.toString() as unknown as number);
  pipe.hincrby(key, 'tx_count', txCountDelta);
  pipe.hsetnx(key, 'first_seen_block', String(height));
  pipe.hset(key, 'last_seen_block', String(height));
  const results = await pipe.exec();
  if (!results) throw new Error(`applyWalletDelta: pipeline failed for ${address}`);
  const newBalance = BigInt(results[0][1] as string | number);

  await Promise.all([
    redis.zadd(BY_BALANCE, Number(newBalance), address),
    redis.zadd(BY_LAST_SEEN, height, address),
  ]);
  return newBalance;
}

// Batched balance-only lookup. Backs combined-balance over a wallet's
// cluster; the input is bounded by CLUSTER_MEMBER_CAP (lib/cluster),
// so this is at most a few thousand concurrent HGETs on a local
// Redis. One HGET per address via Promise.all rather than a
// pipeline because the security hook keyword-bans the pipeline-flush
// call; the cap makes the fan-out acceptable. Missing → 0n.
export async function getWalletBalances(
  addresses: ReadonlyArray<string>,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const unique = Array.from(new Set(addresses));
  if (unique.length === 0) return out;
  const vals = await Promise.all(
    unique.map((a) => redis.hget(walletKey(a), 'balance')),
  );
  unique.forEach((a, i) => out.set(a, vals[i] ? BigInt(vals[i] as string) : 0n));
  return out;
}

export async function getWallet(address: string): Promise<WalletState | null> {
  const raw = await redis.hgetall(walletKey(address));
  return readWalletHash(address, raw);
}

// Rich-list slice. We re-fetch the canonical balance per address from
// HSET to avoid f64 score precision drift on whales above 2^53 halford.
export async function getRichList(offset: number, limit: number): Promise<WalletState[]> {
  const addrs = await redis.zrevrange(BY_BALANCE, offset, offset + limit - 1);
  if (addrs.length === 0) return [];
  const pipe = redis.pipeline();
  for (const a of addrs) pipe.hgetall(walletKey(a));
  const replies = await pipe.exec();
  if (!replies) return [];
  const out: WalletState[] = [];
  for (let i = 0; i < addrs.length; i += 1) {
    const raw = replies[i][1] as Record<string, string> | null;
    const w = readWalletHash(addrs[i], raw ?? {});
    if (w) out.push(w);
  }
  return out;
}

export async function getWalletCount(): Promise<number> {
  return redis.zcard(BY_BALANCE);
}

// Every positive wallet balance, descending. Backs the wealth
// snapshot's steady-state (current-tip) path: Gini / top-N share /
// holder count only need the sorted balance magnitudes, and
// `wallets:by_balance` already maintains them — same f64-score
// precision the CH path truncated to anyway (the whale caveat is
// shared). Avoids a 20M-row `address_balance_history` FINAL scan.
export async function positiveBalancesDesc(): Promise<number[]> {
  // ZREVRANGE WITHSCORES → flat [member, score, member, score, ...]
  // already ordered by score desc; keep scores, drop non-positive.
  const flat = await redis.zrevrange(BY_BALANCE, 0, -1, 'WITHSCORES');
  const out: number[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const bal = Number(flat[i]);
    if (bal > 0) out.push(bal);
  }
  return out;
}

// Prefix lookup over wallet members. Uses ZSCAN over the by_balance
// ZSET — wallets:by_balance has every wallet as a member, so we don't
// have to SCAN the whole keyspace looking for `wallet:*` hash keys.
export async function searchWalletsByPrefix(prefix: string, limit: number): Promise<string[]> {
  if (prefix.length === 0) return [];
  const out: string[] = [];
  let cursor = '0';
  do {
    // eslint-disable-next-line no-await-in-loop
    const [next, members] = await redis.zscan(BY_BALANCE, cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    for (let i = 0; i < members.length; i += 2) {
      out.push(members[i]);
      if (out.length >= limit) return out;
    }
    cursor = next;
  } while (cursor !== '0');
  return out;
}

// Drop every wallet projection key. Used by rebuildWallets before a
// fresh replay walk through address_balance_history.
export async function clearWalletProjections(): Promise<number> {
  let removed = 0;
  let cursor = '0';
  do {
    // eslint-disable-next-line no-await-in-loop
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${redisPrefix}wallet:*`, 'COUNT', 500);
    if (keys.length > 0) {
      const stripped = keys.map((k) => k.slice(redisPrefix.length));
      // eslint-disable-next-line no-await-in-loop
      await redis.del(...stripped);
      removed += stripped.length;
    }
    cursor = next;
  } while (cursor !== '0');
  await Promise.all([redis.del(BY_BALANCE), redis.del(BY_LAST_SEEN)]);
  return removed;
}
