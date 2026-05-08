import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';

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

// See lib/api.ts — same rationale: fall back to '/api' so a prod build
// without the env never leaks dev localhost into the EventSource URL.
const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

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

    // The server fires custom events named after the topic. We attach
    // a generic listener via `onmessage` (the default channel) plus a
    // wildcard via `addEventListener('topic', ...)` only for known
    // topics — but EventSource doesn't support wildcards, so we
    // register listeners for every topic the indexer publishes.
    const KNOWN = [
      'block.new', 'block.tip', 'chain.reorg',
      'mempool.entered', 'mempool.exited', 'mempool.tick', 'mempool.fee_histogram',
      'network.stats', 'metrics.tick', 'metrics.daily', 'backfill.progress',
      'project.added', 'project.removed',
    ];
    KNOWN.forEach((topic) => {
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
