import { config } from '../config';
import { events, ExplorerEvent } from './emitter';
import { log } from './log';
import { redisPub, redisSub } from './redis';

const CHANNEL_PREFIX = `${config.REDIS_PREFIX}:events:`;

/**
 * Publish every locally emitted event to Redis pub/sub. Called from
 * the indexer process so api replicas pick up the same events without
 * sticky sessions.
 *
 * Subscribes to all known topics by name; we don't listen on `*.*`
 * because EventEmitter doesn't support real wildcards (the wildcard
 * channels in emitter.ts are local-only fan-out for SSE filtering).
 */
const PUBLISHED_TOPICS: Array<ExplorerEvent['topic']> = [
  'block.new',
  'block.tip',
  'chain.reorg',
  'mempool.entered',
  'mempool.exited',
  'mempool.tick',
  'mempool.fee_histogram',
  'network.stats',
  'metrics.tick',
  'metrics.daily',
  'backfill.progress',
];

export function publishToRedis(): void {
  PUBLISHED_TOPICS.forEach((topic) => {
    events.on(topic, async (payload) => {
      try {
        await redisPub.publish(`${CHANNEL_PREFIX}${topic}`, JSON.stringify(payload));
      } catch (err) {
        log.warn(`fanout: failed to publish ${topic}`, err);
      }
    });
  });
  // Per-key topics (address.<a>.balance, cpid.<c>.magnitude) are wildcarded
  // — Redis psubscribe handles those on the consumer side, but we need
  // the indexer to publish them too. Bridge via the `*.*` wildcard
  // emitter that `emitter.ts` already fans out.
  events.on('address.*', async (event: ExplorerEvent) => {
    try {
      await redisPub.publish(`${CHANNEL_PREFIX}${event.topic}`, JSON.stringify(event.payload));
    } catch (err) {
      log.warn('fanout: failed to publish address.* event', err);
    }
  });
  events.on('cpid.*', async (event: ExplorerEvent) => {
    try {
      await redisPub.publish(`${CHANNEL_PREFIX}${event.topic}`, JSON.stringify(event.payload));
    } catch (err) {
      log.warn('fanout: failed to publish cpid.* event', err);
    }
  });
}

/**
 * Inverse of publishToRedis: re-emit pub/sub messages on the local
 * EventEmitter so SSE clients in api processes see them.
 */
export async function subscribeFromRedis(): Promise<void> {
  await redisSub.psubscribe(`${CHANNEL_PREFIX}*`);
  redisSub.on('pmessage', (_pattern, channel, message) => {
    const topic = channel.slice(CHANNEL_PREFIX.length);
    try {
      const payload = JSON.parse(message);
      events.emit(topic, payload);
      const dot = topic.indexOf('.');
      if (dot > 0) {
        events.emit(`${topic.slice(0, dot)}.*`, { topic, payload });
      }
    } catch (err) {
      log.warn(`fanout: failed to re-emit ${topic}`, err);
    }
  });
}
