import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { events } from '../../lib/emitter';
import { log } from '../../lib/log';

// Audit P0 #4 caps. The pre-hardening service had no bounds anywhere
// — a single attacker could open thousands of connections, repeatedly
// subscribe with 100-KB topic arrays, and burn server memory holding
// all of them.
//
// Per-IP defaults stay generous because a power user can easily run a
// dozen browser tabs (each opens its own EventSource) and we'd rather
// keep them connected than reject the 6th tab. The audit's original
// "5 conns per IP" suggestion was conservative; total + global RPS
// already shed the worst floods, so we trade a little per-IP slack
// for the self-foot-gun risk of capping legitimate users. Tunable
// via env if a real attack pattern emerges.
export const MAX_CONNECTIONS_TOTAL = Number(process.env.SSE_MAX_CONNECTIONS_TOTAL ?? 5_000);
export const MAX_CONNECTIONS_PER_IP = Number(process.env.SSE_MAX_CONNECTIONS_PER_IP ?? 50);
export const MAX_TOPICS_PER_STREAM = Number(process.env.SSE_MAX_TOPICS_PER_STREAM ?? 32);
export const MAX_TOPIC_LENGTH = Number(process.env.SSE_MAX_TOPIC_LENGTH ?? 64);

interface Client {
  id: string;
  ip: string;
  res: Response;
  /** Topic patterns this client wants. Exact match or "prefix.*" wildcard. */
  topics: Set<string>;
}

/**
 * Topic-aware SSE broadcaster.
 *
 * One TCP connection per browser tab. Clients open `GET /events`,
 * receive their `streamId`, then POST `/events/:streamId/subscribe`
 * with a topics array to register interest. Server-side filtering
 * means we don't fan out the firehose.
 *
 * Topic patterns:
 *   - exact      `block.new`
 *   - wildcard   `address.*` matches `address.<addr>.balance` etc.
 */
export class EventsService {
  private static singleton: EventsService | undefined;

  static getInstance(): EventsService {
    if (!this.singleton) this.singleton = new EventsService();
    return this.singleton;
  }

  private clients: Client[] = [];

  private constructor() {
    // Hook every topic the indexer publishes. The TypedEmitter in
    // lib/emitter.ts also fans `<root>.*` events, which is how we
    // catch `address.<addr>.balance` and `cpid.<cpid>.magnitude`
    // without enumerating every key.
    const TOPICS = [
      'block.new', 'block.tip', 'chain.reorg',
      'mempool.entered', 'mempool.exited', 'mempool.tick', 'mempool.fee_histogram',
      'network.stats', 'metrics.tick', 'metrics.daily', 'backfill.progress',
    ];
    TOPICS.forEach((topic) => {
      events.on(topic, (payload) => {
        this.broadcast(topic, payload);
      });
    });
    events.on('address.*', (event) => {
      this.broadcast(event.topic, event.payload);
    });
    events.on('cpid.*', (event) => {
      this.broadcast(event.topic, event.payload);
    });

    setInterval(() => this.ping(), 15_000);
  }

  addClient(res: Response, ip: string): { ok: true; id: string } | { ok: false; reason: 'total' | 'per-ip' } {
    if (this.clients.length >= MAX_CONNECTIONS_TOTAL) {
      return { ok: false, reason: 'total' };
    }
    const ipCount = this.clients.reduce((n, c) => (c.ip === ip ? n + 1 : n), 0);
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      return { ok: false, reason: 'per-ip' };
    }
    const id = randomUUID();
    this.clients.push({
      id, ip, res, topics: new Set(),
    });
    log.info(`[SSE] client ${id} connected (total=${this.clients.length})`);
    res.write(`event: hello\ndata: ${JSON.stringify({ stream_id: id })}\n\n`);
    return { ok: true, id };
  }

  removeClient(id: string): void {
    this.clients = this.clients.filter((c) => c.id !== id);
    log.info(`[SSE] client ${id} disconnected (total=${this.clients.length})`);
  }

  /**
   * Replace a client's topic set. Caller is expected to have already
   * filtered the topics list down to strings ≤ MAX_TOPIC_LENGTH and
   * truncated to MAX_TOPICS_PER_STREAM — the route enforces those
   * limits so we don't pay the cost twice on broadcast paths.
   * Returns true if the client exists.
   */
  subscribe(id: string, topics: string[]): boolean {
    const client = this.clients.find((c) => c.id === id);
    if (!client) return false;
    client.topics = new Set(topics);
    return true;
  }

  ping(): void {
    if (this.clients.length === 0) return;
    this.clients.forEach((c) => {
      try {
        c.res.write(': keep-alive\n\n');
      } catch (err) {
        log.warn(`[SSE] keep-alive failed for ${c.id}`, err);
      }
    });
  }

  private broadcast(topic: string, payload: unknown): void {
    if (this.clients.length === 0) return;
    const frame = `event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
    this.clients.forEach((client) => {
      if (!matches(client.topics, topic)) return;
      try {
        client.res.write(frame);
      } catch (err) {
        log.warn(`[SSE] broadcast failed for ${client.id}`, err);
      }
    });
  }
}

function matches(patterns: Set<string>, topic: string): boolean {
  if (patterns.has(topic)) return true;
  // Wildcard: subscribing to `address.*` matches `address.<addr>.balance`,
  // `address.<addr>.tx`, etc.
  for (const p of patterns) {
    if (!p.endsWith('.*')) continue;
    const prefix = p.slice(0, -1); // keep the trailing dot
    if (topic.startsWith(prefix)) return true;
  }
  return false;
}
