import { ch } from '../../lib/ch';
import { getTipAnchor } from '../../lib/indexerTip';
import { log } from '../../lib/log';
import { redis } from '../../lib/redis';

const BY_BALANCE = 'wallets:by_balance';
const BY_LAST_SEEN = 'wallets:by_last_seen';

// Daily wealth snapshot. One row per ~24 h interval into the
// `wealth_snapshots` CH table. The dashboard's wealth-distribution
// panel + Lorenz / top-N share series read from there.
//
// Anchored on indexer tip-time, NOT wall-clock — during deep backfill
// chain-time is years behind real-time, and bucketing on wall-clock
// would skew every snapshot to "now" while the indexer is actually
// reasoning about 2017. The bucket_ts we store IS the chain-time we
// snapshotted from.
//
// Wallet projection lives in Redis (post the CQRS refactor); this job
// reads ZSCORE batches off `wallets:by_balance` rather than CH MVs.
export class WealthSnapshotJob {
  async tick(): Promise<void> {
    try {
      const anchor = await getTipAnchor();
      const bucketTs = Math.floor(anchor / 86400) * 86400;

      const existing = await ch.query({
        query: 'SELECT count() AS c FROM wealth_snapshots WHERE bucket_ts = toDateTime({bt: UInt32})',
        query_params: { bt: bucketTs },
        format: 'JSONEachRow',
      });
      const count = Number((await existing.json<{ c: string | number }>())[0]?.c ?? 0);
      if (count > 0) return;

      // Total supply from the latest indexed block.
      const supplyResult = await ch.query({
        query: `
          SELECT toString(max(money_supply)) AS supply
          FROM blocks FINAL
          WHERE time <= toDateTime({at: UInt32})
        `,
        query_params: { at: anchor },
        format: 'JSONEachRow',
      });
      const totalSupply = BigInt((await supplyResult.json<{ supply: string | null }>())[0]?.supply ?? '0');

      // Pull every wallet's score from the by_balance ZSET. WITHSCORES
      // gives [member, score, member, score, …]. Score is the balance
      // in halford as a JS Number (f64); precise enough for ranking
      // and good enough for Gini at the dashboard's display fidelity.
      const flat = await redis.zrevrange(BY_BALANCE, 0, -1, 'WITHSCORES');
      const balances: number[] = [];
      const addresses: string[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const score = Number(flat[i + 1]);
        if (!Number.isFinite(score) || score <= 0) continue;
        addresses.push(flat[i]);
        balances.push(score);
      }
      const totalBal = balances.reduce((acc, b) => acc + b, 0);
      const addressesWithBalance = balances.length;

      const topShare = (n: number): number => {
        if (totalBal === 0 || balances.length === 0) return 0;
        const slice = balances.slice(0, Math.min(n, balances.length));
        return slice.reduce((acc, b) => acc + b, 0) / totalBal;
      };
      const top1pctShare = topShare(Math.max(1, Math.ceil(addressesWithBalance / 100)));
      const top10pctShare = topShare(Math.max(1, Math.ceil(addressesWithBalance / 10)));
      const top100Share = topShare(100);

      // Gini from the sorted-descending balance array. Standard formula:
      //   gini = (2 * Σ(rank_asc * x_i) − (n+1) * Σx_i) / (n * Σx_i)
      // We have descending order; converting rank requires flipping i.
      let gini = 0;
      if (addressesWithBalance > 0 && totalBal > 0) {
        let weightedSum = 0;
        for (let i = 0; i < balances.length; i += 1) {
          weightedSum += (i + 1) * balances[i];
        }
        gini = (2 * weightedSum - (addressesWithBalance + 1) * totalBal)
          / (addressesWithBalance * totalBal);
        gini = -gini; // flip sign because of descending sort
      }

      // Cutoff heights for active / hodler windows.
      const cutoffSecondsMap = {
        '24h': 86_400,
        '30d': 30 * 86_400,
        '180d': 180 * 86_400,
      } as const;
      const cutoffHeights: Record<string, number> = {};
      for (const [key, secs] of Object.entries(cutoffSecondsMap)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await ch.query({
          query: `
            SELECT max(height) AS h FROM blocks FINAL
            WHERE time <= toDateTime({cutoff: UInt32})
          `,
          query_params: { cutoff: anchor - secs },
          format: 'JSONEachRow',
        });
        cutoffHeights[key] = Number((await r.json<{ h: number | null }>())[0]?.h ?? 0);
      }

      // active_24h = wallets with last_seen_block in the last 24h. ZSET
      // wallets:by_last_seen is scored by block_height — ZCOUNT in
      // [cutoff_24h, +inf] gives the count directly.
      const active24h = await redis.zcount(BY_LAST_SEEN, cutoffHeights['24h'], '+inf');
      // hodler_30d / hodler_180d = wallets with balance > 0 whose
      // last_seen_block is at-or-below the cutoff (haven't moved
      // recently). We can't ZCOUNT on by_last_seen directly because
      // we also need balance > 0; intersect with the wallets-by-balance
      // set in JS, since the count is small and bounded.
      const lastSeenAddrs30d = await redis.zrangebyscore(BY_LAST_SEEN, '-inf', cutoffHeights['30d']);
      const lastSeenAddrs180d = await redis.zrangebyscore(BY_LAST_SEEN, '-inf', cutoffHeights['180d']);
      const richSet = new Set(addresses);
      const hodler30d = lastSeenAddrs30d.filter((a) => richSet.has(a)).length;
      const hodler180d = lastSeenAddrs180d.filter((a) => richSet.has(a)).length;

      // new_24h = addresses whose first_seen_block came in the last
      // 24h. CH event log has every (address, valid_from_height); we
      // filter for "this is the FIRST appearance" via min().
      const newResult = await ch.query({
        query: `
          SELECT count() AS c FROM (
            SELECT address, min(valid_from_height) AS first_seen
            FROM address_balance_history FINAL
            WHERE address != ''
            GROUP BY address
            HAVING first_seen >= {cutoff: UInt32}
          )
        `,
        query_params: { cutoff: cutoffHeights['24h'] },
        format: 'JSONEachRow',
      });
      const new24h = Number((await newResult.json<{ c: string | number }>())[0]?.c ?? 0);

      await ch.insert({
        table: 'wealth_snapshots',
        format: 'JSONEachRow',
        values: [{
          bucket_ts: bucketTs,
          total_supply: totalSupply.toString(),
          addresses_with_balance: addressesWithBalance,
          gini: gini.toFixed(8),
          top1pct_share: top1pctShare.toFixed(8),
          top10pct_share: top10pctShare.toFixed(8),
          top100_share: top100Share.toFixed(8),
          active_24h: active24h,
          new_24h: new24h,
          hodler_30d: hodler30d,
          hodler_180d: hodler180d,
        }],
      });
      log.info(`WealthSnapshot: wrote bucket ${bucketTs} (gini=${gini.toFixed(4)}, addresses=${addressesWithBalance})`);
    } catch (err) {
      log.warn('WealthSnapshotJob.tick failed', err);
    }
  }
}
