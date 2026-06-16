import { query } from './db';

// A real wallet is at most a few hundred addresses; anything past
// this is a multi-party / exchange-hot-wallet over-merge (the
// documented heuristic caveat) whose combined balance is meaningless
// anyway. Cap the expansion so a pathological supercluster can't turn
// a single address-page hit into tens of thousands of DB rows + Redis
// HGETs. No legitimate wallet is truncated by this.
const CLUSTER_MEMBER_CAP = 10_000;

// Union of every cluster touched by any of `seed` (including the
// seeds themselves), in exactly two batched queries regardless of
// |seed| — for combined-balance over a wallet's full footprint (the
// viewed address + its CPID-signal siblings, expanded by co-spend).
//
// address is the PRIMARY KEY (one cluster assignment per address via
// upsert), so a plain `address = ANY(...)` / `cluster_id = ANY(...)`
// lookup needs no dedup. On error/absent it degrades to the dedup'd
// seed set, so callers just fall back to the narrower (CPID-signal) view.
export async function getClustersForAddresses(seed: string[]): Promise<string[]> {
  const uniqueSeed = Array.from(new Set(seed.filter((s) => s !== '')));
  if (uniqueSeed.length === 0) return [];
  try {
    const r1 = await query<{ cid: string }>(
      `
        SELECT DISTINCT cluster_id AS cid
        FROM address_clusters
        WHERE address = ANY($addrs) AND cluster_id != ''
      `,
      { addrs: uniqueSeed },
    );
    const cids = r1.map((x) => x.cid);
    if (cids.length === 0) return uniqueSeed;
    const r2 = await query<{ address: string }>(
      `
        SELECT address
        FROM address_clusters
        WHERE cluster_id = ANY($cids)
        LIMIT ${CLUSTER_MEMBER_CAP}
      `,
      { cids },
    );
    const members = r2.map((m) => m.address);
    return Array.from(new Set([...uniqueSeed, ...members]));
  } catch {
    return uniqueSeed;
  }
}
