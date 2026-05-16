import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PUBLIC_BASE } from '../lib/api';

interface SubscriptionHandle {
  topics: string[];
  cb: (topic: string, payload: unknown) => void;
}

interface SSEContextValue {
  /** Subscribe to a set of topics (exact or `prefix.*`). Returns unsubscribe. */
  subscribe(topics: string[], cb: (topic: string, payload: unknown) => void): () => void;
  /** Most recent connection state, useful for "live" badges in the UI. */
  connected: boolean;
}

const SSEContext = createContext<SSEContextValue | null>(null);

// Static topic list the server publishes by name. Wildcard per-key
// topics (`address.<addr>.balance`, `cpid.<cpid>.magnitude`) ride on
// the default `onmessage` channel since their event names aren't
// statically knowable. Hoisted to module scope so it's allocated once,
// not per provider mount.
const KNOWN_TOPICS = [
  'block.new', 'block.tip', 'superblock.new', 'chain.reorg',
  'mempool.entered', 'mempool.exited', 'mempool.tick', 'mempool.fee_histogram',
  'network.stats', 'metrics.tick', 'metrics.daily', 'backfill.progress',
  'project.added', 'project.removed',
  'wealth.snapshot', 'beacon.update',
  'sidestake.update', 'sidestake.payout',
] as const;
export type SseTopic = typeof KNOWN_TOPICS[number] | `${string}.*` | string;

/**
 * One shared EventSource per browser tab. Components register topic
 * sets via `useSSE(topics, cb)`; the provider keeps a server-side
 * subscription that's the union of all registered topics, then dispatches
 * matching events to the right components.
 *
 * Why one connection: an explorer page may watch one address; a
 * dashboard may watch dozens. Spinning up an EventSource per component
 * burns sockets and rate limits.
 */
export function SSEProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const subsRef = useRef<Map<number, SubscriptionHandle>>(new Map());
  const counterRef = useRef(0);
  const streamIdRef = useRef<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  // Debounce subscription updates. Page navigations cause every component
  // on the old page to unsubscribe and every component on the new page to
  // subscribe in rapid succession (10+ within ~50ms on the home dashboard).
  // Without this, every transition fires a stampede of POSTs that block
  // the browser's network slot until they all complete — making nav feel
  // sluggish. Coalescing into one POST per tick is the obvious fix.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSubscriptions = () => {
    if (!streamIdRef.current) return;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (!streamIdRef.current) return;
      const all = new Set<string>();
      subsRef.current.forEach((h) => h.topics.forEach((t) => all.add(t)));
      fetch(`${PUBLIC_BASE}/events/${streamIdRef.current}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topics: Array.from(all) }),
        keepalive: true,
      }).catch(() => { /* swallow — next event will retry */ });
    }, 50);
  };

  // Tab-visibility gate. While the tab is hidden, events still arrive
  // over the EventSource (browsers keep connections alive in the
  // background, and even if they didn't, server-side resends would
  // cost more), but we skip dispatch — no React reconciliation, no
  // recharts redraw, no setState. When the user comes back, panels
  // re-fetch (where applicable) on visibility change so they catch up
  // with anything they missed.
  const visibleRef = useRef<boolean>(typeof document !== 'undefined' ? !document.hidden : true);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVis = () => { visibleRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    const source = new EventSource(`${PUBLIC_BASE}/events`);
    sourceRef.current = source;

    source.addEventListener('hello', (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        streamIdRef.current = msg.stream_id;
        setConnected(true);
        refreshSubscriptions();
      } catch (_err) { /* ignore */ }
    });

    source.onerror = () => {
      setConnected(false);
    };

    // EventSource doesn't support wildcards, so we register a listener
    // per statically-known topic. Per-key topics use the default
    // `onmessage` channel below.
    KNOWN_TOPICS.forEach((topic) => {
      source.addEventListener(topic, (e) => {
        if (!visibleRef.current) return;
        try {
          const payload = JSON.parse((e as MessageEvent).data);
          dispatch(topic, payload);
        } catch (_err) { /* ignore */ }
      });
    });
    // Per-key topics (`address.<addr>.balance`, `cpid.<cpid>.magnitude`)
    // are dispatched via the default message handler since their event
    // names aren't statically knowable.
    source.onmessage = (e) => {
      // The server uses named events for everything; default messages
      // would only happen on misconfiguration. Ignore.
      void e;
    };

    return () => {
      source.close();
      sourceRef.current = null;
      streamIdRef.current = null;
      setConnected(false);
    };
  }, []);

  const dispatch = (topic: string, payload: unknown) => {
    subsRef.current.forEach((h) => {
      if (h.topics.some((p) => topicMatches(p, topic))) {
        h.cb(topic, payload);
      }
    });
  };

  const value = useMemo<SSEContextValue>(() => ({
    connected,
    subscribe(topics, cb) {
      counterRef.current += 1;
      const id = counterRef.current;
      subsRef.current.set(id, { topics, cb });
      refreshSubscriptions();
      return () => {
        subsRef.current.delete(id);
        refreshSubscriptions();
      };
    },
  }), [connected]);

  return <SSEContext.Provider value={value}>{children}</SSEContext.Provider>;
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern.endsWith('.*')) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Subscribe a component to one or more SSE topics. The callback is
 * invoked with the original topic name plus the payload, so a single
 * subscription on `address.*` can disambiguate between
 * `address.<addr>.balance` and `address.<addr>.tx`.
 */
export function useSSE(topics: string[], cb: (topic: string, payload: unknown) => void): boolean {
  const ctx = useContext(SSEContext);
  // Re-register only when the topic set actually changes to avoid
  // thrashing the server-side subscription on every render.
  const key = topics.slice().sort().join('|');
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.subscribe(topics, (t, p) => cbRef.current(t, p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key]);
  return ctx?.connected ?? false;
}

/**
 * Subscribe to SSE topics and run `refresh` at most once per
 * `debounceMs`. The canonical "panel re-fetches on SSE tick, but not
 * faster than this" pattern that ~10 dashboard widgets re-implement.
 *
 * `skip` is honoured before scheduling so the time-machine replay
 * path (where SSE is irrelevant) doesn't pile up timers that fire
 * after replay exits.
 */
export function useSSEDebounced(
  topics: string[],
  refresh: () => void,
  debounceMs: number,
  options: {
    skip?: boolean;
    /** Optional gate on the incoming event — returning false skips
     *  scheduling. Use for "only this granularity / only this action"
     *  filters (e.g. `(_t, p) => (p as { granularity?: string }).granularity === '1h'`). */
    predicate?: (topic: string, payload: unknown) => boolean;
  } = {},
): void {
  const { skip = false, predicate } = options;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const predicateRef = useRef(predicate);
  predicateRef.current = predicate;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(topics, (topic, payload) => {
    if (skipRef.current) return;
    if (predicateRef.current && !predicateRef.current(topic, payload)) return;
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refreshRef.current();
    }, debounceMs);
  });
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
}
