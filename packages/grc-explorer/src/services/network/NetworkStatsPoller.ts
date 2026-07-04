import { query, run } from '../../lib/db';
import { events } from '../../lib/emitter';
import { liveRpc } from '../../lib/gridcoin';
import { log } from '../../lib/log';
import { getCursor, redis } from '../../lib/redis';

const CACHE_KEY = 'network:stats';
const CACHE_TTL_SECONDS = 60;

interface NetworkInfo {
  version: number;
  protocolVersion: number;
  connections: number;
}

interface BlockchainInfo {
  blocks: number;
  bestblockhash?: string;
  // Gridcoin's getblockchaininfo returns `difficulty` as an object
  // ({ current, target } per gridcoin-rpc's typings) — not a scalar.
  // Older builds may have returned a number; accept either shape so we
  // don't lose the value across daemon versions.
  difficulty: number | { current: number; target: number };
}

export interface NetworkStatsPayload {
  // Daemon's chain tip. Null when we've never gotten a successful RPC
  // tip and no prior snapshot exists — DO NOT fake it from the latest
  // indexed block, that makes the UI falsely report "caught up" during
  // early backfill.
  tip_height: number | null;
  tip_hash: string;
  indexed_height: number | null;
  indexer_status: string;
  difficulty: string;
  peer_count: number;
  mempool_size: number;
  // Older Gridcoin builds shipped these as packed integers; current
  // builds return human strings (e.g. `"v5.5.0.1-unk"`). Accept either.
  net_version: number | string;
  rpc_version: number | string;
}

// Polls the daemon every NETWORK_STATS_INTERVAL_MS:
//   1. caches the latest snapshot in Redis (so /network is O(1)),
//   2. emits an SSE `network.stats` event,
//   3. inserts a row into `network_snapshots` so /network/history can
//      serve a time-series for the dashboard sparklines.
export class NetworkStatsPoller {
  async tick(): Promise<void> {
    // Promise.allSettled rather than Promise.all: when one RPC call
    // is failing the remaining stats should still flow into the cache.
    const settled = await Promise.allSettled([
      liveRpc.getBlockchainInfo(),
      liveRpc.getNetworkInfo(),
      liveRpc.getRawMemPool().then((m) => m.length),
      liveRpc.getConnectionCount(),
      // Difficulty as observed by the indexer (not the daemon's
      // "live" reading) — the two diverge during backfill, and
      // explorers conventionally show the historical value.
      query<{ difficulty: number; height: number; hash: string }>(
        // The `height` PK makes the max-height row unique, so a plain
        // top-1 read returns the chain tip's difficulty directly.
        `
          SELECT difficulty, height, hash
          FROM blocks
          WHERE height = (SELECT max(height) FROM blocks)
          LIMIT 1
        `,
      ).then((rows) => rows[0] ?? null),
      getCursor(),
    ]);

    const pick = <T>(idx: number): T | undefined => {
      const r = settled[idx];
      return r.status === 'fulfilled' ? (r.value as T) : undefined;
    };
    const chain = pick<BlockchainInfo>(0);
    const net = pick<NetworkInfo>(1);
    const mempoolCount = pick<number>(2);
    const peerCount = pick<number>(3);
    const latestIndexed = pick<{ difficulty: number; height: number; hash: string } | null>(4) ?? null;
    const cursor = pick<{ height: number; status: string } | null>(5) ?? null;

    if (!chain && !net && peerCount === undefined && mempoolCount === undefined && !latestIndexed && !cursor) {
      log.warn('NetworkStatsPoller tick: every source failed; cache untouched');
      return;
    }

    const liveDifficulty = chain && typeof chain.difficulty === 'object' && chain.difficulty !== null
      ? chain.difficulty.current
      : chain?.difficulty;
    const difficultyStr = latestIndexed?.difficulty
      ? latestIndexed.difficulty.toString()
      : String(liveDifficulty ?? 0);
    const ts = Math.floor(Date.now() / 1000);

    const previous = await NetworkStatsPoller.readCache() as Partial<NetworkStatsPayload> | null;
    const payload: NetworkStatsPayload = {
      tip_height: chain?.blocks ?? previous?.tip_height ?? null,
      tip_hash: chain?.bestblockhash ?? previous?.tip_hash ?? '',
      indexed_height: cursor?.height ?? previous?.indexed_height ?? null,
      indexer_status: cursor?.status ?? previous?.indexer_status ?? 'backfilling',
      difficulty: difficultyStr !== '0' ? difficultyStr : (previous?.difficulty ?? '0'),
      peer_count: peerCount ?? previous?.peer_count ?? 0,
      mempool_size: mempoolCount ?? previous?.mempool_size ?? 0,
      net_version: net?.version ?? previous?.net_version ?? 0,
      rpc_version: net?.protocolVersion ?? previous?.rpc_version ?? 0,
    };
    const payloadJson = JSON.stringify(payload);
    // Skip the Redis write + SSE fanout when the payload is byte-
    // identical to the cached one. Difficulty / peer_count /
    // mempool_size only move on block + connection events; at 15s
    // poll cadence the unchanged case is the common case and the
    // fanout to thousands of SSE clients isn't free.
    const previousJson = previous ? JSON.stringify(previous) : null;
    if (payloadJson !== previousJson) {
      await redis.set(CACHE_KEY, payloadJson, 'EX', CACHE_TTL_SECONDS);
      events.publish({ topic: 'network.stats', payload });
    }

    if (peerCount !== undefined && mempoolCount !== undefined && chain) {
      try {
        // Append-only: network_snapshots has no PK, so a plain INSERT.
        // ts is unix-seconds → FROM_UNIXTIME; difficulty is DOUBLE.
        await run(
          `
            INSERT INTO network_snapshots (ts, peer_count, mempool_size, difficulty, tip_height)
            VALUES (FROM_UNIXTIME($ts), $peer_count, $mempool_size, $difficulty, $tip_height)
          `,
          {
            ts,
            peer_count: peerCount,
            mempool_size: mempoolCount,
            difficulty: Number(difficultyStr),
            tip_height: chain.blocks,
          },
        );
      } catch (err) {
        log.warn('NetworkStatsPoller failed to persist snapshot', err);
      }
    }
    // network_snapshots retention is handled out of band; the poller
    // only appends.
  }

  static async readCache(): Promise<unknown | null> {
    const raw = await redis.get(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  }
}
