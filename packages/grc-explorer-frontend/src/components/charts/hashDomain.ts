// Chart view state (zoom window + annotation marker) lives in the URL
// *fragment* (`#z=min_max&zm=x`), never the query string: it's a
// client-only view concern, so the server never needs it (no SSR, no
// getServerSideProps re-run) and crawlers never see it (zero SEO
// footprint). Values are in the chart's own x-unit (epoch seconds, block
// height, …), rounded to integers for tidy links.

function hashParams(): URLSearchParams {
  return new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, ''),
  );
}

export function readHashDomain(key: string): [number, number] | null {
  const raw = hashParams().get(key);
  if (!raw) return null;
  const [a, b] = raw.split('_').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return [a, b];
}

export function readHashNumber(key: string): number | null {
  const raw = hashParams().get(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Batch set/delete of fragment keys in a single replaceState (so writing
// zoom + marker together doesn't churn history twice). `null` deletes.
export function writeHashParams(updates: Record<string, string | null>): void {
  if (typeof window === 'undefined') return;
  const params = hashParams();
  for (const [k, v] of Object.entries(updates)) {
    if (v == null) params.delete(k);
    else params.set(k, v);
  }
  const h = params.toString();
  const url = window.location.pathname + window.location.search + (h ? `#${h}` : '');
  // replaceState (not push): a drag-zoom / marker click shouldn't spam
  // browser history.
  window.history.replaceState(window.history.state, '', url);
}
