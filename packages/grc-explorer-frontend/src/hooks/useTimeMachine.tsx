import {
  createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { TIME_MACHINE_ENABLED } from '../lib/featureFlags';
import { nowSec } from '../lib/format';

/**
 * Time-machine clock. When `at` is null the dashboard is in live mode
 * (panels follow SSE events as they arrive). When `at` is a unix-seconds
 * value, panels reconstruct their state at that moment.
 *
 * URL contract:
 *   /                                  → live
 *   /?replay=1&at=<ts>                 → replay, paused at ts
 *   /?replay=1&at=<ts>&speed=10        → replay, playing at 10× chain time
 *
 * The provider:
 *   - Reads URL params on mount, pushes back as state mutates (so the
 *     URL is always shareable).
 *   - Fetches /network/bounds once to clamp the slider.
 *   - When playing, advances `at` by `realDt * speed` every 200ms and
 *     stops at maxTs.
 */

export interface Bounds { minTs: number; maxTs: number; minHeight: number; maxHeight: number }
export type Speed = 1 | 10 | 60 | 600 | 3600;
export const SPEEDS: Speed[] = [1, 10, 60, 600, 3600];

interface TimeMachineState {
  isReplay: boolean;
  at: number | null;            // unix seconds; null = live
  playing: boolean;
  speed: Speed;
  bounds: Bounds | null;        // null until first bounds fetch
}

interface TimeMachineApi extends TimeMachineState {
  enterReplay(at?: number): void;
  goLive(): void;
  setAt(ts: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  setSpeed(s: Speed): void;
  step(deltaSeconds: number): void;
}

const Ctx = createContext<TimeMachineApi | null>(null);

const isBrowser = typeof window !== 'undefined';

function readInitialState(): { replay: boolean; at: number | null; speed: Speed } {
  // Feature-flagged off: ignore any `?replay=1&at=...` from a stale
  // shareable link so the dashboard stays in live mode even when the
  // URL was minted while the time machine was on.
  if (!isBrowser || !TIME_MACHINE_ENABLED) return { replay: false, at: null, speed: 60 };
  const sp = new URLSearchParams(window.location.search);
  const replay = sp.get('replay') === '1';
  const atRaw = parseInt(sp.get('at') ?? '', 10);
  const speedRaw = parseInt(sp.get('speed') ?? '', 10);
  const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : null;
  const speed = (SPEEDS as number[]).includes(speedRaw) ? (speedRaw as Speed) : 60;
  return { replay, at, speed };
}

export function TimeMachineProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readInitialState, []);

  const [isReplay, setIsReplay] = useState<boolean>(initial.replay);
  const [at, setAtState] = useState<number | null>(initial.at);
  const [playing, setPlaying] = useState<boolean>(false);
  const [speed, setSpeedState] = useState<Speed>(initial.speed);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  // Fetch the indexed range once. Refresh every 60s so the slider's
  // upper bound moves with the indexer.
  useEffect(() => {
    let alive = true;
    const fetchBounds = () => api.get('/network/bounds').then((r) => {
      if (!alive) return;
      const a = r.data?.data?.attributes;
      if (a && typeof a.minTs === 'number' && typeof a.maxTs === 'number') {
        setBounds({
          minTs: a.minTs,
          maxTs: a.maxTs,
          minHeight: a.minHeight ?? 0,
          maxHeight: a.maxHeight ?? 0,
        });
      }
    }).catch(() => { /* ignore — provider stays usable, bounds clamped only client-side */ });
    fetchBounds();
    const id = setInterval(fetchBounds, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Mirror state into the URL via the History API directly. Using
  // Next's router.replace was triggering full page re-renders (likely
  // because _app.tsx's getInitialProps disables shallow routing in
  // pages-router). history.replaceState mutates the URL without
  // touching the router, so panels don't re-mount and Live doesn't
  // feel like a reload — the shareable-URL contract is preserved.
  const syncUrlRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isBrowser) return;
    if (syncUrlRef.current) clearTimeout(syncUrlRef.current);
    syncUrlRef.current = setTimeout(() => {
      const sp = new URLSearchParams(window.location.search);
      if (isReplay) {
        sp.set('replay', '1');
        if (at !== null) sp.set('at', String(at)); else sp.delete('at');
        sp.set('speed', String(speed));
      } else {
        sp.delete('replay');
        sp.delete('at');
        sp.delete('speed');
      }
      const qs = sp.toString();
      const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
      window.history.replaceState(window.history.state, '', newUrl);
    }, 200);
  }, [isReplay, at, speed]);

  // Player loop. Tick once per second in real time; advance `at` by
  // (realDt * speed). The slow tick rate matters: every `at` change
  // ripples out to ~10+ dashboard panels, each of which refetches its
  // data. A 200ms tick blew through the 30/sec API rate limit. 1s is
  // smooth enough — at 60× speed the chain advances 1 minute per real
  // second, which the eye reads as continuous movement anyway. Pauses
  // automatically at maxTs.
  useEffect(() => {
    if (!playing || !isReplay) return undefined;
    let prev = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - prev) / 1000;
      prev = now;
      setAtState((curAt) => {
        if (curAt === null) return curAt;
        const next = curAt + dt * speed;
        const max = bounds?.maxTs;
        if (max !== undefined && next >= max) {
          // Hit the live edge — stop playback.
          setPlaying(false);
          return max;
        }
        return Math.floor(next);
      });
    }, 1000);
    return () => clearInterval(id);
  }, [playing, speed, isReplay, bounds?.maxTs]);

  const enterReplay = useCallback((target?: number) => {
    setIsReplay(true);
    if (target !== undefined) setAtState(target);
    else if (at === null) {
      // Default: 1 hour back from the latest indexed block.
      const seed = bounds?.maxTs ? bounds.maxTs - 3600 : nowSec() - 3600;
      setAtState(seed);
    }
  }, [at, bounds?.maxTs]);

  const goLive = useCallback(() => {
    setIsReplay(false);
    setPlaying(false);
    setAtState(null);
  }, []);

  const setAt = useCallback((ts: number) => {
    setAtState(ts);
  }, []);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const togglePlay = useCallback(() => setPlaying((p) => !p), []);
  const setSpeed = useCallback((s: Speed) => setSpeedState(s), []);
  const step = useCallback((deltaSeconds: number) => {
    setAtState((curAt) => {
      if (curAt === null) return curAt;
      const next = curAt + deltaSeconds;
      const min = bounds?.minTs ?? 0;
      const max = bounds?.maxTs ?? Number.MAX_SAFE_INTEGER;
      return Math.min(max, Math.max(min, Math.floor(next)));
    });
  }, [bounds?.minTs, bounds?.maxTs]);

  const value = useMemo<TimeMachineApi>(() => ({
    isReplay,
    at,
    playing,
    speed,
    bounds,
    enterReplay,
    goLive,
    setAt,
    play,
    pause,
    togglePlay,
    setSpeed,
    step,
  }), [
    isReplay, at, playing, speed, bounds,
    enterReplay, goLive, setAt, play, pause, togglePlay, setSpeed, step,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Hook for consumers. Always defined — components outside the provider
 *  see live mode (`at: null`). */
export function useTimeMachine(): TimeMachineApi {
  const v = useContext(Ctx);
  if (v) return v;
  // Fallback when the provider isn't mounted (SSR, isolated tests).
  return {
    isReplay: false,
    at: null,
    playing: false,
    speed: 60,
    bounds: null,
    enterReplay: () => undefined,
    goLive: () => undefined,
    setAt: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    togglePlay: () => undefined,
    setSpeed: () => undefined,
    step: () => undefined,
  };
}

/** Build a query string fragment to append to API calls — handles the
 *  null-when-live case so panels can do `api.get('/blocks' + atQs(at))`. */
export function atQuery(at: number | null, key = 'at'): string {
  if (at === null) return '';
  return `${key}=${at}`;
}

/** Convenience: returns the value to put into axios `params`. */
export function atParam(at: number | null): Record<string, number> {
  return at === null ? {} : { at };
}
