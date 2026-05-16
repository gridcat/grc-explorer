import { ch } from './ch';

// A real wallet is at most a few hundred addresses; anything past
// this is a multi-party / exchange-hot-wallet over-merge (the
// documented heuristic caveat) whose combined balance is meaningless
// anyway. Cap the expansion so a pathological supercluster can't turn
// a single address-page hit into tens of thousands of CH rows + Redis
// HGETs. No legitimate wallet is truncated by this.
const CLUSTER_MEMBER_CAP = 10_000;

// Union of every cluster touched by any of `seed` (including the
// seeds themselves), in exactly two batched queries regardless of
// |seed| — for combined-balance over a wallet's full footprint (the
// viewed address + its CPID-signal siblings, expanded by co-spend).
//
// No FINAL anywhere (it ignores the cluster_id bloom and forces the
// merge path): per-address `argMax(_, _seq)` collapses the
// ReplacingMergeTree to the latest rebuild's assignment, and every
// alias is distinct from the column it's compared against so a
// predicate never binds to an aggregate (ClickHouse error 184 — a
// trap hit repeatedly in this codebase; see the perf-audit memo).
//
// On error/absent it degrades to the dedup'd seed set, so callers
// just fall back to the narrower (CPID-signal) view.
export async function getClustersForAddresses(seed: string[]): Promise<string[]> {
  const uniqueSeed = Array.from(new Set(seed.filter((s) => s !== '')));
  if (uniqueSeed.length === 0) return [];
  try {
    const r1 = await ch.query({
      query: `
        SELECT DISTINCT cid FROM (
          SELECT address, argMax(cluster_id, _seq) AS cid
          FROM address_clusters
          WHERE address IN ({addrs: Array(String)})
          GROUP BY address
        )
        WHERE cid != ''
      `,
      query_params: { addrs: uniqueSeed },
      format: 'JSONEachRow',
    });
    const cids = (await r1.json<{ cid: string }>()).map((x) => x.cid);
    if (cids.length === 0) return uniqueSeed;
    const r2 = await ch.query({
      query: `
        SELECT address FROM (
          SELECT address, argMax(cluster_id, _seq) AS cur
          FROM address_clusters
          WHERE cluster_id IN ({cids: Array(String)})
          GROUP BY address
          HAVING cur IN ({cids: Array(String)})
        )
        LIMIT {cap: UInt32}
      `,
      query_params: { cids, cap: CLUSTER_MEMBER_CAP },
      format: 'JSONEachRow',
    });
    const members = (await r2.json<{ address: string }>()).map((m) => m.address);
    return Array.from(new Set([...uniqueSeed, ...members]));
  } catch {
    return uniqueSeed;
  }
}
