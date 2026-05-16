import { ch } from '../../lib/ch';
import { log } from '../../lib/log';
import { nextSeq, redis } from '../../lib/redis';

// Address clustering via the common-input-ownership heuristic: every
// input of a tx is signed by its owner, so all input addresses of a
// tx are the same wallet. Transitive closure (union-find) over every
// tx recovers each wallet's full spent-address set — the breadth
// CPID-bound signals (beacon/stake/MRC) miss. Writes
// `address_clusters` (migration 0034): one row per address that's in
// a MULTI-member cluster; never-co-spent addresses get no row.
//
// Periodic FULL rebuild (not incremental): union-find isn't cheaply
// reversible on reorg, and a full pass is idempotent and self-heals
// any reorg drift. The rebuild is heavy (one big GROUP BY over all of
// tx_inputs), so it's gated on a Redis last-run timestamp — which
// PERSISTS ACROSS RESTARTS, so schedule()'s immediate first tick on
// every hot-reload does NOT re-trigger the scan (the BoincStatsImport
// lesson). Default cadence ~12h.
//
// Memory: a string→int intern map over every address that has ever
// been a tx input (~1-2M on mainnet) plus parallel typed arrays —
// a few hundred MB transient during the run. Acceptable for a 12h
// job; the heavy lifting (the GROUP BY) is on ClickHouse.
//
// Caveat: over-merges on multi-party txs (CoinJoin/PayJoin) and fuses
// everything an exchange hot-wallet co-spends with. Rare on Gridcoin;
// accepted and surfaced as "related", not "proven owned" (same stance
// as gridcoinstats).

const REBUILD_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'address_clusters:last_run_ms';
const INSERT_CHUNK = 50_000;

export class AddressClusterJob {
  async tick(): Promise<void> {
    try {
      const lastRunRaw = await redis.get(LAST_RUN_KEY);
      const lastRun = lastRunRaw ? Number(lastRunRaw) : 0;
      if (Date.now() - lastRun < REBUILD_INTERVAL_MS) return; // restart-proof gate

      const startedAt = Date.now();
      // Intern addresses to ints; union-find with path-compression +
      // union-by-size; track the lexicographically smallest member
      // per root as the stable cluster_id.
      const idOf = new Map<string, number>();
      const addrOf: string[] = [];
      const parent: number[] = [];
      const size: number[] = [];
      const minAddr: string[] = [];

      const intern = (a: string): number => {
        let id = idOf.get(a);
        if (id !== undefined) return id;
        id = addrOf.length;
        idOf.set(a, id);
        addrOf.push(a);
        parent.push(id);
        size.push(1);
        minAddr.push(a);
        return id;
      };
      const find = (x: number): number => {
        let r = x;
        while (parent[r] !== r) r = parent[r];
        let c = x;
        while (parent[c] !== c) { const n = parent[c]; parent[c] = r; c = n; }
        return r;
      };
      const union = (a: number, b: number): void => {
        let ra = find(a);
        let rb = find(b);
        if (ra === rb) return;
        if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
        parent[rb] = ra;
        size[ra] += size[rb];
        if (minAddr[rb] < minAddr[ra]) minAddr[ra] = minAddr[rb];
      };

      // No FINAL: a tx's input-address SET is unaffected by un-merged
      // duplicate _seq rows (groupUniqArray dedups), and FINAL would
      // force the merge path. Heavy full GROUP BY — periodic by design.
      const rs = await ch.query({
        query: `
          SELECT groupUniqArray(address) AS addrs
          FROM tx_inputs
          WHERE address != ''
          GROUP BY tx_id
        `,
        format: 'JSONEachRow',
      });
      let txGroups = 0;
      for await (const batch of rs.stream()) {
        for (const row of batch) {
          const { addrs } = row.json<{ addrs: string[] }>();
          if (!addrs || addrs.length < 2) continue; // singletons cluster nothing
          const base = intern(addrs[0]);
          for (let i = 1; i < addrs.length; i += 1) union(base, intern(addrs[i]));
          txGroups += 1;
        }
      }

      // Resolve every address to its cluster's min-address id; emit
      // only members of multi-member clusters.
      const clusterSizeByRoot = new Map<number, number>();
      for (let i = 0; i < addrOf.length; i += 1) {
        const r = find(i);
        clusterSizeByRoot.set(r, (clusterSizeByRoot.get(r) ?? 0) + 1);
      }
      const seq = (await nextSeq()).toString();
      let rows: Array<{
        address: string; cluster_id: string; cluster_size: number; _seq: string;
      }> = [];
      let written = 0;
      const flush = async (): Promise<void> => {
        if (rows.length === 0) return;
        await ch.insert({ table: 'address_clusters', format: 'JSONEachRow', values: rows });
        written += rows.length;
        rows = [];
      };
      for (let i = 0; i < addrOf.length; i += 1) {
        const r = find(i);
        const cSize = clusterSizeByRoot.get(r) ?? 1;
        if (cSize < 2) continue;
        rows.push({
          address: addrOf[i], cluster_id: minAddr[r], cluster_size: cSize, _seq: seq,
        });
        if (rows.length >= INSERT_CHUNK) {
          // eslint-disable-next-line no-await-in-loop
          await flush();
        }
      }
      await flush();

      await redis.set(LAST_RUN_KEY, String(Date.now()));
      log.info(
        `AddressClusterJob: ${written} clustered addresses across `
        + `${clusterSizeByRoot.size} roots from ${txGroups} multi-input txs `
        + `(${addrOf.length} distinct input addresses, `
        + `${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    } catch (err) {
      // Don't set last_run on failure → retried next scheduled tick.
      log.warn('AddressClusterJob.tick failed', err);
    }
  }
}
