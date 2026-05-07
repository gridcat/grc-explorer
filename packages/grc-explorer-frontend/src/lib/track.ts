/**
 * Tiny wrapper around Plausible's custom-events API. Plausible exposes
 * a global `window.plausible(event, { props })` function once the
 * script (loaded in _app.tsx) has hydrated. We don't want any caller
 * to crash if the script is blocked, deferred, or simply absent in
 * dev — `track()` no-ops in that case.
 *
 * Privacy: only pass low-cardinality string/number props. Never log
 * user search queries, full hashes, or anything PII-like — Plausible
 * stores the props verbatim and we want to keep this site cookieless
 * and unprofiling-friendly.
 */
type PlausibleFn = (event: string, opts?: { props?: Record<string, string | number | boolean> }) => void;

declare global {
  interface Window {
    plausible?: PlausibleFn & { q?: unknown[] };
  }
}

export function track(event: string, props?: Record<string, string | number | boolean>): void {
  if (typeof window === 'undefined') return;
  const fn = window.plausible;
  if (typeof fn !== 'function') return;
  try {
    fn(event, props ? { props } : undefined);
  } catch {
    /* swallow — analytics must never break the page */
  }
}
