import { query } from '../lib/db';
import { getTipAnchor } from '../lib/indexerTip';
import { log } from '../lib/log';
import { closeRedis } from '../lib/redis';
import { WealthSnapshotJob } from '../services/jobs/WealthSnapshotJob';

// Dry-run parity gate for the streaming WealthSnapshotJob rewrite.
// Recomputes every ALREADY-WRITTEN wealth_snapshots bucket via the
// streaming pass (writes nothing) and diffs against the stored rows —
// the ones the retired per-bucket scan produced. Counts must match
// exactly; ratio fields (gini/shares) within 1e-9 (both paths are
// f64). total_supply is reported but tolerated: the old path took
// max(money_supply) ≤ boundary, the new one takes the value AT the
// boundary (carried past NULLs) — they differ only if the counter
// ever dips.
//
// Usage: npx ts-node src/scripts/wealthParity.ts

interface StoredRow {
  bt: number;
  total_supply: string;
  addresses_with_balance: number;
  gini: number;
  top1pct_share: number;
  top10pct_share: number;
  top100_share: number;
  active_24h: number;
  new_24h: number;
  hodler_30d: number;
  hodler_180d: number;
}

// Ratio columns are DECIMAL(10,8) — stored values are rounded to 8
// decimal places, so a freshly computed f64 can differ by up to 5e-9
// plus the f64 read-back noise. 1e-7 keeps the gate meaningful while
// clearing the storage rounding.
const RATIO_TOL = 1e-7;

async function main(): Promise<void> {
  const stored = await query<StoredRow>(
    `
      SELECT UNIX_TIMESTAMP(bucket_ts) AS bt, CAST(total_supply AS CHAR) AS total_supply,
             addresses_with_balance, gini, top1pct_share, top10pct_share, top100_share,
             active_24h, new_24h, hodler_30d, hodler_180d
      FROM wealth_snapshots
    `,
  );
  const byBucket = new Map<number, StoredRow>();
  for (const r of stored) byBucket.set(Number(r.bt), r);
  log.info(`wealthParity: ${byBucket.size} stored bucket(s) to compare`);
  if (byBucket.size === 0) {
    log.info('wealthParity: nothing to compare — done');
    return;
  }

  const anchor = await getTipAnchor();
  const currentBucket = Math.floor(anchor / 86_400) * 86_400;

  let compared = 0;
  let mismatches = 0;
  let supplyDiffs = 0;
  const job = new WealthSnapshotJob();
  // Empty `existing` set → the pass computes EVERY bucket; onRow
  // intercepts them instead of persisting.
  await job.streamingPass(new Set<number>(), currentBucket, (row) => {
    const want = byBucket.get(row.bucketTs);
    if (!want) return; // bucket the old path never wrote — nothing to diff
    compared += 1;

    const bad: string[] = [];
    const counts: Array<[string, number, number]> = [
      ['addresses_with_balance', want.addresses_with_balance, row.addressesWithBalance],
      ['active_24h', want.active_24h, row.active24h],
      ['new_24h', want.new_24h, row.new24h],
      ['hodler_30d', want.hodler_30d, row.hodler30d],
      ['hodler_180d', want.hodler_180d, row.hodler180d],
    ];
    for (const [name, a, b] of counts) {
      if (Number(a) !== b) bad.push(`${name}: stored=${a} new=${b}`);
    }
    const ratios: Array<[string, number, number]> = [
      ['gini', want.gini, row.gini],
      ['top1pct_share', want.top1pct_share, row.top1pctShare],
      ['top10pct_share', want.top10pct_share, row.top10pctShare],
      ['top100_share', want.top100_share, row.top100Share],
    ];
    for (const [name, a, b] of ratios) {
      if (Math.abs(Number(a) - b) > RATIO_TOL) bad.push(`${name}: stored=${a} new=${b}`);
    }
    if (want.total_supply !== row.totalSupply) {
      supplyDiffs += 1;
      if (supplyDiffs <= 5) {
        log.info(`wealthParity: supply differs at ${row.bucketTs}: stored=${want.total_supply} new=${row.totalSupply} (tolerated)`);
      }
    }
    if (bad.length > 0) {
      mismatches += 1;
      if (mismatches <= 20) {
        log.warn(`wealthParity: MISMATCH at bucket ${row.bucketTs} (${new Date(row.bucketTs * 1000).toISOString().slice(0, 10)}): ${bad.join('; ')}`);
      }
    }
  });

  log.info(`wealthParity: compared=${compared} mismatches=${mismatches} supplyDiffs=${supplyDiffs}`);
  if (mismatches > 0) {
    log.error('wealthParity: FAILED — do not enable the streaming path until this is understood');
    process.exitCode = 1;
  } else {
    log.info('wealthParity: PASSED');
  }
}

if (require.main === module) {
  main()
    .then(async () => { await closeRedis(); process.exit(process.exitCode ?? 0); })
    .catch(async (err) => {
      log.error('wealthParity failed', err);
      await closeRedis();
      process.exit(1);
    });
}
