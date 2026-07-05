import { chunked } from '../../lib/chunked';
import { config } from '../../config';
// Reads go through the maintenance reader pool (aliased to `query`) so
// this job's paged tx_inputs / cluster scans can't starve the API readers.
import { maintenanceQuery as query, run, upsert } from '../../lib/db';
import { log } from '../../lib/log';
import { getCursor, redis } from '../../lib/redis';

// Address clustering via the common-input-ownership heuristic: every
// input of a tx is signed by its owner, so all input addresses of a
// tx are the same wallet. Transitive closure (union-find) over every
// tx recovers each wallet's full spent-address set — the breadth
// CPID-bound signals (beacon/stake/MRC) miss. Writes
// `address_clusters`: one row per address that's in a MULTI-member
// cluster; never-co-spent addresses get no row.
//
// INCREMENTAL since the MariaDB low-resource work: each tick processes
// only tx_inputs above a Redis watermark (minus the reorg window,
// re-merging which is an idempotent no-op) and merges the new co-spend
// groups into the persisted clusters — a few point reads + a handful
// of upserts per hour, instead of the old 11M-row full scan every 12h
// (~10 min on the dev box; would have been ~an hour of HDD saturation
// per run on prod). Merge direction: the SMALLER side adopts the
// LARGER side's cluster_id, bounding the rewrite to the smaller
// membership (cluster_id is opaque to readers — lib/cluster.ts only
// groups by it — so abandoning the min-address convention on merge is
// safe; fresh clusters still use their min address as the id).
//
// cluster_size on rows not touched by a merge goes stale (nothing
// reads it today — it's forensic metadata); the full rebuild refreshes
// it everywhere.
//
// The FULL rebuild survives as the repair tool: it runs automatically
// when address_clusters is empty (fresh install) and on demand via
// `npm run admin -- rebuild-clusters`. Reorged-AWAY co-spends leave a
// stale over-merge the incremental path can't undo (union-find isn't
// reversible) — same accepted "related, not proven-owned" caveat as
// CoinJoin over-merges; run the full rebuild if it ever matters.
//
// Watermark init without a stored key: a non-empty table (prod seeded
// via mariabackup, or dev after a rebuild) replays the trailing
// SEED_REPLAY_BLOCKS once — generously covering the seed→boot gap —
// because merges are idempotent. An empty table triggers the full
// rebuild instead.

const WATERMARK_KEY = 'address_clusters:watermark_height';
const SEED_REPLAY_BLOCKS = 5_000;
const INSERT_CHUNK = 50_000;
const IN_LIST_CHUNK = 10_000;

interface TxGroup {
  addresses: string[]; // ≥2 distinct input addresses of one tx
}

export class AddressClusterJob {
  async tick(): Promise<void> {
    try {
      const cursor = await getCursor();
      if (!cursor || !Number.isFinite(cursor.height)) return;
      const hi = cursor.height;

      const rawWatermark = await redis.get(WATERMARK_KEY);
      let watermark = rawWatermark === null ? NaN : Number(rawWatermark);
      if (!Number.isFinite(watermark)) {
        const seeded = await query<{ x: number }>('SELECT 1 AS x FROM address_clusters LIMIT 1');
        if (seeded.length === 0) {
          await this.fullRebuild();
          return;
        }
        watermark = Math.max(0, hi - SEED_REPLAY_BLOCKS);
        log.info(`AddressClusterJob: no watermark; replaying from ${watermark} over seeded clusters`);
      }

      const lo = Math.max(0, watermark - config.MAX_REORG_DEPTH);
      if (hi <= lo) {
        await redis.set(WATERMARK_KEY, String(hi));
        return;
      }

      const startedAt = Date.now();
      const groups = await this.coSpendGroups(lo, hi);
      if (groups.length === 0) {
        await redis.set(WATERMARK_KEY, String(hi));
        return;
      }
      const { merged, written } = await this.mergeGroups(groups);
      await redis.set(WATERMARK_KEY, String(hi));
      if (written > 0) {
        log.info(
          `AddressClusterJob: merged ${merged} co-spend group(s), rewrote ${written} row(s) `
          + `over blocks (${lo}, ${hi}] (${Math.round((Date.now() - startedAt) / 1000)}s)`,
        );
      }
    } catch (err) {
      // Watermark not advanced on failure → the range is retried next tick.
      log.warn('AddressClusterJob.tick failed', err);
    }
  }

  // Multi-input-address groups in a height range. DISTINCT pairs
  // ordered by tx_id, grouped in JS; served by idx_tx_inputs_block.
  private async coSpendGroups(lo: number, hi: number): Promise<TxGroup[]> {
    const rows = await query<{ tx_id: string; address: string }>(
      `
        SELECT DISTINCT tx_id, address
        FROM tx_inputs
        WHERE block_height > $lo AND block_height <= $hi AND address != ''
        ORDER BY tx_id
      `,
      { lo, hi },
    );
    const groups: TxGroup[] = [];
    let currentTx: string | null = null;
    let addrs: string[] = [];
    const closeGroup = (): void => {
      if (addrs.length >= 2) groups.push({ addresses: addrs });
    };
    for (const row of rows) {
      if (row.tx_id !== currentTx) {
        closeGroup();
        currentTx = row.tx_id;
        addrs = [];
      }
      addrs.push(row.address);
    }
    closeGroup();
    return groups;
  }

  // Merge co-spend groups into the persisted clusters. Union-find over
  // hybrid nodes: one node per address seen this tick + one node per
  // EXISTING cluster an address already belongs to — so merging two
  // 50k-member clusters never loads 100k rows, just links two nodes;
  // only the losing side's membership is rewritten afterwards.
  private async mergeGroups(groups: TxGroup[]): Promise<{ merged: number; written: number }> {
    const allAddrs = Array.from(new Set(groups.flatMap((g) => g.addresses)));

    // Existing assignment per address (absent → unclustered so far).
    const cidOf = new Map<string, string>();
    for (const slice of chunked(allAddrs, IN_LIST_CHUNK)) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await query<{ address: string; cluster_id: string }>(
        'SELECT address, cluster_id FROM address_clusters WHERE address IN ($addrs)',
        { addrs: [...slice] },
      );
      for (const r of rows) cidOf.set(r.address, r.cluster_id);
    }

    // Union-find over node keys ('a:'+address | 'c:'+cluster_id).
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
      let c = x;
      while ((parent.get(c) ?? c) !== c) {
        const n = parent.get(c) as string;
        parent.set(c, r);
        c = n;
      }
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    for (const a of allAddrs) {
      const cid = cidOf.get(a);
      if (cid !== undefined) union(`a:${a}`, `c:${cid}`);
    }
    for (const g of groups) {
      const base = `a:${g.addresses[0]}`;
      for (let i = 1; i < g.addresses.length; i += 1) union(base, `a:${g.addresses[i]}`);
    }

    // Components → involved existing clusters + fresh addresses.
    const compCids = new Map<string, Set<string>>();
    const compAddrs = new Map<string, string[]>();
    for (const a of allAddrs) {
      const root = find(`a:${a}`);
      let list = compAddrs.get(root);
      if (!list) { list = []; compAddrs.set(root, list); }
      list.push(a);
      const cid = cidOf.get(a);
      if (cid !== undefined) {
        let set = compCids.get(root);
        if (!set) { set = new Set(); compCids.set(root, set); }
        set.add(cid);
      }
    }

    let merged = 0;
    let written = 0;
    let pending: Array<{ address: string; cluster_id: string; cluster_size: number }> = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      await upsert('address_clusters', pending, { pk: ['address'] });
      written += pending.length;
      pending = [];
    };

    for (const [root, addrs] of compAddrs) {
      const cids = Array.from(compCids.get(root) ?? []);
      const fresh = addrs.filter((a) => cidOf.get(a) === undefined);
      if (cids.length === 0) {
        // Brand-new cluster: min-address id, all members written.
        if (addrs.length < 2) continue;
        const id = [...addrs].sort()[0];
        for (const a of addrs) pending.push({ address: a, cluster_id: id, cluster_size: addrs.length });
        merged += 1;
      } else if (cids.length === 1 && fresh.length === 0) {
        // Everything already sits in the same cluster — no-op replay.
        continue;
      } else {
        // Adopt the largest involved cluster's id. Losing clusters are
        // re-pointed with ONE indexed UPDATE per component — atomic per
        // statement, so a crash can't strand half a cluster under the
        // old id (a per-member rewrite could), and no member list ever
        // needs loading. Fresh addresses follow in a separate upsert:
        // if that fails, the retry sees the clusters already merged and
        // re-attaches just the fresh side.
        const sizes = new Map<string, number>();
        for (const slice of chunked(cids, IN_LIST_CHUNK)) {
          // eslint-disable-next-line no-await-in-loop
          const rows = await query<{ cid: string; c: number | string }>(
            `SELECT cluster_id AS cid, count(*) AS c FROM address_clusters
             WHERE cluster_id IN ($cids) GROUP BY cluster_id`,
            { cids: [...slice] },
          );
          for (const r of rows) sizes.set(r.cid, Number(r.c));
        }
        let target = cids[0];
        let loserTotal = 0;
        for (const cid of cids) {
          if ((sizes.get(cid) ?? 0) > (sizes.get(target) ?? 0)) target = cid;
        }
        const losers = cids.filter((c) => c !== target);
        for (const cid of losers) loserTotal += sizes.get(cid) ?? 0;
        const newSize = (sizes.get(target) ?? 0) + loserTotal + fresh.length;
        if (losers.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          await run(
            `UPDATE address_clusters SET cluster_id = $target, cluster_size = $size
             WHERE cluster_id IN ($losers)`,
            { target, size: newSize, losers },
          );
        }
        for (const a of fresh) pending.push({ address: a, cluster_id: target, cluster_size: newSize });
        merged += 1;
      }
      if (pending.length >= INSERT_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }
    await flush();
    return { merged, written };
  }

  // ---------------------------------------------------------------
  // Full rebuild — fresh installs (empty table) + the admin repair
  // task. One big scan of tx_inputs; heavy by design, never scheduled.
  // ---------------------------------------------------------------

  async fullRebuild(): Promise<number> {
    const cursor = await getCursor();
    // Snapshot the tip BEFORE scanning so the watermark can't skip
    // blocks written mid-rebuild; overlap re-merges are no-ops.
    const watermarkAfter = cursor && Number.isFinite(cursor.height) ? cursor.height : 0;

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

    // Walk tx_inputs in PK keyset pages instead of one 11M-row result
    // set (which OOMs a memory-capped prod node). Each page is a pure
    // PK range scan — no sort, no temp table; tx groups arrive
    // contiguous and the current group carries across page borders.
    // Addresses are deduped per group in JS (replaces SELECT DISTINCT).
    const PAGE = 500_000;
    let txGroups = 0;
    let currentTx: string | null = null;
    let groupAddrs = new Set<string>();
    const processGroup = (): void => {
      if (groupAddrs.size < 2) return; // singletons cluster nothing
      const addrs = Array.from(groupAddrs);
      const base = intern(addrs[0]);
      for (let i = 1; i < addrs.length; i += 1) union(base, intern(addrs[i]));
      txGroups += 1;
    };
    let lastTx = '';
    let lastVin = -1;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await query<{ tx_id: string; vin_n: number; address: string }>(
        `
          SELECT tx_id, vin_n, address
          FROM tx_inputs
          WHERE tx_id > $t OR (tx_id = $t AND vin_n > $v)
          ORDER BY tx_id, vin_n
          LIMIT ${PAGE}
        `,
        { t: lastTx, v: lastVin },
      );
      for (const row of page) {
        if (row.tx_id !== currentTx) {
          processGroup();
          currentTx = row.tx_id;
          groupAddrs = new Set();
        }
        if (row.address !== '' && row.address !== null) groupAddrs.add(row.address);
      }
      if (page.length < PAGE) break;
      const tail = page[page.length - 1];
      lastTx = tail.tx_id;
      lastVin = Number(tail.vin_n);
    }
    processGroup(); // final group

    // Start from a clean slate: this rebuild is the documented repair
    // for stale over-merges, which an upsert-only rewrite would leave
    // in place (rows whose address no longer belongs to any multi-
    // member cluster). The brief window of partial data is acceptable
    // for an admin/bootstrap operation — cluster reads degrade to the
    // seed set (lib/cluster.ts) rather than erroring.
    await run('TRUNCATE TABLE address_clusters');

    // Resolve every address to its cluster's min-address id; emit
    // only members of multi-member clusters.
    const clusterSizeByRoot = new Map<number, number>();
    for (let i = 0; i < addrOf.length; i += 1) {
      const r = find(i);
      clusterSizeByRoot.set(r, (clusterSizeByRoot.get(r) ?? 0) + 1);
    }
    let rows: Array<{
      address: string; cluster_id: string; cluster_size: number;
    }> = [];
    let written = 0;
    const flush = async (): Promise<void> => {
      if (rows.length === 0) return;
      await upsert('address_clusters', rows, { pk: ['address'] });
      written += rows.length;
      rows = [];
    };
    for (let i = 0; i < addrOf.length; i += 1) {
      const r = find(i);
      const cSize = clusterSizeByRoot.get(r) ?? 1;
      if (cSize < 2) continue;
      rows.push({
        address: addrOf[i], cluster_id: minAddr[r], cluster_size: cSize,
      });
      if (rows.length >= INSERT_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }
    await flush();

    await redis.set(WATERMARK_KEY, String(watermarkAfter));
    log.info(
      `AddressClusterJob: full rebuild — ${written} clustered addresses across `
      + `${clusterSizeByRoot.size} roots from ${txGroups} multi-input txs `
      + `(${addrOf.length} distinct input addresses, `
      + `${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    return written;
  }
}
