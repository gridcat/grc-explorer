// Staking-client version helpers.
//
// The on-chain `claim.client_version` string is irregular: an optional
// leading `v`, an optional git/build suffix (`-gfe6ab878a`, `-unk`), and
// inconsistent presence of the `v` (`5.4.5.0` vs `v5.4.5.0`).
// `normalizeClientVersion` collapses those to a clean dotted release id;
// anything non-numeric falls into `OTHER_VERSION`.

export const OTHER_VERSION = 'other';

export function normalizeClientVersion(raw: string | null | undefined): string {
  if (!raw) return OTHER_VERSION;
  // Drop a leading `v`/`V`, then everything from the first `-`/`+` build
  // suffix on (`v5.3.2.0-gfe6ab878a`, `v5.3.2.0-unk` → `5.3.2.0`).
  const v = raw.trim().replace(/^v/i, '').replace(/[-+].*$/, '');
  return /^\d+(\.\d+){1,3}$/.test(v) ? v : OTHER_VERSION;
}

// Newest release first, for the legend / colour order.
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Days at the tip whose daily-dominant version is always shown, so the
// *current* release appears even though its lifetime total is still tiny.
const RECENT_WINDOW_SECONDS = 30 * 86_400;

export interface DailyVersionRow {
  ts: number;
  date: string;
  raw_version: string;
  blocks: number;
}

export interface VersionPoint {
  ts: number;
  date: string;
  // Per-version block count for this day. A version absent from the map
  // is zero — the renderer must treat missing keys as 0 when stacking.
  counts: Record<string, number>;
  total: number;
}

export interface VersionSeries {
  // Series keys ordered by version number, newest first. `other` is never
  // a series.
  versions: string[];
  points: VersionPoint[];
}

// Long-format (ts, date, raw_version, blocks) rows → one daily point per
// day (with a per-version block map + the full day total) and the set of
// versions to draw as lines.
//
// On-chain client_version goes back to the earliest Gridcoin releases
// (v3.x in 2014), so this spans the whole chain and dozens of versions.
//
// Which versions become lines:
//  - the top-N by **total blocks** (a release's lifetime footprint, the
//    analogue of "top researchers by magnitude"), so the consequential
//    releases of every era show and one-off build strings drop out; PLUS
//  - whichever version is daily-dominant in the last 30 days, so the
//    *current* release always appears even though, days after launch, its
//    lifetime total is still far too small to crack the top-N.
//
// Drawing lines (not a stack) means there's no `other` series; but `other`
// (normalized garbage) and non-selected versions still count toward each
// day's `total`, so the per-version shares stay honest fractions of all
// staking activity. Output is ordered by version number, newest first.
export function rollupClientVersions(rows: DailyVersionRow[], topN = 20): VersionSeries {
  const dayTotal = new Map<number, number>();
  const dayVer = new Map<number, Map<string, number>>();
  const dateByTs = new Map<number, string>();
  const grandTotal = new Map<string, number>();
  for (const r of rows) {
    const v = normalizeClientVersion(r.raw_version);
    dayTotal.set(r.ts, (dayTotal.get(r.ts) ?? 0) + r.blocks);
    let dv = dayVer.get(r.ts);
    if (!dv) { dv = new Map(); dayVer.set(r.ts, dv); }
    dv.set(v, (dv.get(v) ?? 0) + r.blocks);
    if (!dateByTs.has(r.ts)) dateByTs.set(r.ts, r.date);
    grandTotal.set(v, (grandTotal.get(v) ?? 0) + r.blocks);
  }

  // Top-N real releases by total blocks.
  const selected = new Set(
    [...grandTotal.entries()]
      .filter(([v]) => v !== OTHER_VERSION)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([v]) => v),
  );

  // Recency guarantee: add the daily-dominant version for each of the last
  // 30 days (the current release plus whatever it's overtaking).
  const latestTs = dayTotal.size > 0 ? Math.max(...dayTotal.keys()) : 0;
  for (const [ts, dv] of dayVer) {
    if (ts < latestTs - RECENT_WINDOW_SECONDS) continue;
    let lead: string | null = null;
    let leadN = 0;
    for (const [v, n] of dv) {
      if (v === OTHER_VERSION) continue;
      if (n > leadN) { leadN = n; lead = v; }
    }
    if (lead) selected.add(lead);
  }

  const byTs = new Map<number, VersionPoint>();
  for (const [ts, dv] of dayVer) {
    const p: VersionPoint = {
      ts, date: dateByTs.get(ts) ?? '', counts: {}, total: dayTotal.get(ts) ?? 0,
    };
    for (const [v, n] of dv) if (selected.has(v)) p.counts[v] = n;
    byTs.set(ts, p);
  }
  const points = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const versions = [...selected].sort(compareVersionsDesc);

  return { versions, points };
}
