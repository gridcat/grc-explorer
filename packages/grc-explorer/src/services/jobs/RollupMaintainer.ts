import { query, run } from '../../lib/db';

// Incremental maintenance for the materialised rollup tables (migration
// 0002), replacing DuckDB's recompute-on-read VIEWs. Strategy:
// recompute-the-trailing-window. After each applied batch we recompute
// every rollup bucket from a time floor `tLo = batchMinTime - MARGIN`
// forward, by DELETE-ing those buckets and re-aggregating the current
// base rows in that range. This is:
//   - correct under backfill: blocks arrive in time order, so each batch
//     rebuilds the buckets it crosses; by the end every bucket is final.
//   - correct under reorg: a reorg is ≤ MAX_REORG_DEPTH (100) blocks, far
//     inside MARGIN, so the next forward apply recomputes the affected
//     buckets from whatever base rows survive (a bucket that lost all its
//     blocks simply gets no row). No delta arithmetic, no double-count.
//   - cheap: only the trailing window is touched; historical buckets are
//     immutable and never rescanned.
//
// MARGIN is wall-clock-generous (24 h ≫ 100 blocks at live spacing) so a
// deep-ish reorg can never outrun it. The base-table scans are index-
// pruned on `time` (idx_blocks_time) / `block_time`, so the window is a
// few hundred rows. All time math is UTC — the server runs
// default-time-zone=+00:00 (compose) so FROM_UNIXTIME/UNIX_TIMESTAMP/DATE
// match DuckDB's UTC timestamps.
const MARGIN_SEC = 24 * 60 * 60;

// One (delete, insert) pair per rollup. `floor` is the bucket-aligned unix
// second from which we recompute; passed to both the DELETE (by bucket key)
// and the INSERT's base-table filter so a partially-covered bucket is
// recomputed whole.
async function refreshTimeBucket(
  table: string,
  granSec: number,
  floorTs: number,
  insertSelect: (bucketExpr: string, fromTs: number) => { sql: string; params: Record<string, unknown> },
  timeCol = 'time',
): Promise<void> {
  const aligned = Math.floor(floorTs / granSec) * granSec;
  await run(`DELETE FROM ${table} WHERE bucket_ts >= $f`, { f: aligned });
  const bucketExpr = `(UNIX_TIMESTAMP(${timeCol}) DIV ${granSec}) * ${granSec}`;
  const { sql, params } = insertSelect(bucketExpr, aligned);
  await run(sql, params);
}

// Daily rollups share the DELETE half (key on DATE(time), UTC); only the
// INSERT body differs. The caller passes its bespoke INSERT (which reads
// `$t` = the recompute floor) and this runs the shared delete first.
async function refreshDaily(table: string, insertSql: string, tLo: number): Promise<void> {
  await run(`DELETE FROM ${table} WHERE bucket_date >= DATE(FROM_UNIXTIME($t))`, { t: tLo });
  await run(insertSql, { t: tLo });
}

// Serialise + coalesce refreshes. The backfiller fires runPostCommit (and
// thus refreshRollups) fire-and-forget, so without this two overlapping
// passes race the per-rollup DELETE+INSERT and collide on the bucket PK
// ("Duplicate entry … for key 'PRIMARY'"). Each pass is a trailing-window
// rebuild, so a queued one is redundant — we keep only the EARLIEST pending
// start time (widest window, covers every later batch) and run one at a
// time. Callers after the first just lower the watermark and return.
let running = false;
let pendingFrom: number | null = null;

export async function refreshRollups(batchMinTimeUnix: number): Promise<void> {
  pendingFrom = pendingFrom === null
    ? batchMinTimeUnix
    : Math.min(pendingFrom, batchMinTimeUnix);
  if (running) return;
  running = true;
  try {
    while (pendingFrom !== null) {
      const from = pendingFrom;
      pendingFrom = null;
      // eslint-disable-next-line no-await-in-loop
      await doRefresh(from);
    }
  } finally {
    running = false;
  }
}

async function doRefresh(batchMinTimeUnix: number): Promise<void> {
  const tLo = Math.max(0, batchMinTimeUnix - MARGIN_SEC);

  // ---- network_5m / 1h / 1d (blocks) ----
  for (const [table, gran] of [['network_5m', 300], ['network_1h', 3600], ['network_1d', 86400]] as const) {
    // eslint-disable-next-line no-await-in-loop
    await refreshTimeBucket(table, gran, tLo, (bucket, fromTs) => ({
      sql: `
        INSERT INTO ${table} (bucket_ts, block_count, tx_count, mint_total, bytes_total)
        SELECT ${bucket} AS bucket_ts, count(*), sum(tx_count), sum(mint), sum(size)
        FROM blocks WHERE time >= FROM_UNIXTIME($from)
        GROUP BY bucket_ts`,
      params: { from: fromTs },
    }));
  }

  // ---- tx_5m / tx_1h (user txs) ----
  for (const [table, gran] of [['tx_5m', 300], ['tx_1h', 3600]] as const) {
    // eslint-disable-next-line no-await-in-loop
    await refreshTimeBucket(table, gran, tLo, (bucket, fromTs) => ({
      sql: `
        INSERT INTO ${table} (bucket_ts, value_moved, fee_total)
        SELECT ${bucket} AS bucket_ts, sum(total_out), sum(fee)
        FROM transactions
        WHERE NOT is_coinbase AND NOT is_coinstake AND time >= FROM_UNIXTIME($from)
        GROUP BY bucket_ts`,
      params: { from: fromTs },
    }));
  }

  // ---- claims_5m / claims_1h (bucketed by claims.block_time) ----
  for (const [table, gran] of [['claims_5m', 300], ['claims_1h', 3600]] as const) {
    // eslint-disable-next-line no-await-in-loop
    await refreshTimeBucket(table, gran, tLo, (bucket, fromTs) => ({
      sql: `
        INSERT INTO ${table} (bucket_ts, research_subsidy_total, block_subsidy_total)
        SELECT ${bucket} AS bucket_ts, sum(research_subsidy), sum(block_subsidy)
        FROM claims
        WHERE block_time IS NOT NULL AND block_time >= FROM_UNIXTIME($from)
        GROUP BY bucket_ts`,
      params: { from: fromTs },
    }), 'block_time');
  }

  // ---- fee_quantiles_1h (per-KB fee percentiles over fee-bearing txs) ----
  {
    const aligned = Math.floor(tLo / 3600) * 3600;
    await run('DELETE FROM fee_quantiles_1h WHERE bucket_ts >= $f', { f: aligned });
    await run(
      `INSERT INTO fee_quantiles_1h (bucket_ts, p50, p95, p99, tx_count)
       SELECT DISTINCT
         bucket_ts,
         PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY feekb) OVER (PARTITION BY bucket_ts),
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY feekb) OVER (PARTITION BY bucket_ts),
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY feekb) OVER (PARTITION BY bucket_ts),
         count(*) OVER (PARTITION BY bucket_ts)
       FROM (
         SELECT (UNIX_TIMESTAMP(time) DIV 3600) * 3600 AS bucket_ts,
                fee * 1024.0 / size AS feekb
         FROM transactions
         WHERE NOT is_coinbase AND NOT is_coinstake AND fee > 0 AND size > 0
           AND time >= FROM_UNIXTIME($from)
       ) x`,
      { from: aligned },
    );
  }

  // ---- daily archives + difficulty + stakers + client versions ----
  // All key on DATE(time) (UTC) and share the recompute-from-day DELETE
  // (refreshDaily); only the INSERT aggregation differs per rollup.
  await refreshDaily(
    'archive_blocks_daily',
    `INSERT INTO archive_blocks_daily
       (bucket_date, block_count, tx_count, mint_total, bytes_total, pos_count, superblock_count)
     SELECT DATE(time), count(*), sum(tx_count), sum(mint), sum(size),
            sum(CASE WHEN is_pos THEN 1 ELSE 0 END),
            sum(CASE WHEN is_superblock THEN 1 ELSE 0 END)
     FROM blocks WHERE time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(time)`,
    tLo,
  );

  await refreshDaily(
    'archive_txs_daily',
    `INSERT INTO archive_txs_daily (bucket_date, value_moved, fee_total, user_tx_count)
     SELECT DATE(time), sum(total_out), sum(fee), count(*)
     FROM transactions
     WHERE NOT is_coinbase AND NOT is_coinstake AND time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(time)`,
    tLo,
  );

  await refreshDaily(
    'archive_minters_daily',
    `INSERT INTO archive_minters_daily (bucket_date, miners_uniq, stakers_uniq)
     SELECT DATE(time), count(DISTINCT miner_address), count(DISTINCT staker_cpid)
     FROM blocks WHERE time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(time)`,
    tLo,
  );

  await refreshDaily(
    'difficulty_daily',
    `INSERT INTO difficulty_daily
       (bucket_date, difficulty_min, difficulty_max, difficulty_avg, difficulty_count,
        difficulty_open, difficulty_close)
     SELECT DATE(b.time), min(b.difficulty), max(b.difficulty), avg(b.difficulty), count(*),
            (SELECT difficulty FROM blocks WHERE height = min(b.height)),
            (SELECT difficulty FROM blocks WHERE height = max(b.height))
     FROM blocks b WHERE b.time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(b.time)`,
    tLo,
  );

  await refreshDaily(
    'stakers_daily',
    `INSERT INTO stakers_daily
       (bucket_date, researcher_stakers, investor_stakers, total_stakers, mint_sum, pos_blocks)
     SELECT DATE(time),
            count(DISTINCT CASE WHEN staker_cpid IS NOT NULL THEN miner_address END),
            count(DISTINCT CASE WHEN staker_cpid IS NULL     THEN miner_address END),
            count(DISTINCT miner_address),
            sum(mint), count(*)
     FROM blocks WHERE is_pos AND time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(time)`,
    tLo,
  );

  await refreshDaily(
    'client_versions_daily',
    `INSERT INTO client_versions_daily (bucket_date, raw_version, blocks)
     SELECT DATE(block_time), client_version, count(*)
     FROM claims
     WHERE client_version IS NOT NULL AND client_version <> ''
       AND block_time IS NOT NULL AND block_time >= DATE(FROM_UNIXTIME($t))
     GROUP BY DATE(block_time), client_version`,
    tLo,
  );

  // ---- superblock_researcher_stats (per-superblock, height-keyed) ----
  // Same trailing-window recompute, but the key is a superblock HEIGHT:
  // resolve the first superblock inside the window (superblocks arrive
  // ~daily, so this touches 1-2 of them) and rebuild from there. No
  // superblock in the window → nothing to do.
  {
    const hRows = await query<{ h: number | null }>(
      `SELECT MIN(s.height) AS h
       FROM superblocks s JOIN blocks b ON b.height = s.height
       WHERE b.time >= FROM_UNIXTIME($t)`,
      { t: tLo },
    );
    const hLo = hRows[0]?.h;
    if (hLo !== null && hLo !== undefined) {
      await run(
        'DELETE FROM superblock_researcher_stats WHERE superblock_height >= $h',
        { h: hLo },
      );
      await run(
        `INSERT INTO superblock_researcher_stats
           (superblock_height, active, total_magnitude, top10_magnitude)
         SELECT
           superblock_height,
           SUM(CASE WHEN magnitude > 0 THEN 1 ELSE 0 END),
           COALESCE(SUM(magnitude), 0),
           COALESCE(SUM(CASE WHEN rn <= 10 AND magnitude > 0 THEN magnitude ELSE 0 END), 0)
         FROM (
           SELECT superblock_height, magnitude,
                  ROW_NUMBER() OVER (PARTITION BY superblock_height ORDER BY magnitude DESC) AS rn
           FROM superblock_magnitudes
           WHERE superblock_height >= $h
         ) ranked
         GROUP BY superblock_height`,
        { h: hLo },
      );
    }
  }
}
