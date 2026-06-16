import './lib/bigintJson';
import { config } from './config';
import { closeDb, rebuildSecondaryIndexes } from './lib/db';
import { waitForRpc } from './lib/gridcoin';
import { log } from './lib/log';
import {
  clearIndexRebuildNeeded,
  closeRedis,
  isIndexRebuildNeeded,
} from './lib/redis';
import { schedule } from './lib/schedule';
import { installSignalHandlers, onShutdown } from './lib/shutdown';
import { publishToRedis, subscribeFromRedis } from './lib/fanout';
import { ChainReorgHandler } from './services/indexer/ChainReorgHandler';
import { HistoricalBackfiller } from './services/indexer/HistoricalBackfiller';
import { MempoolWatcher } from './services/indexer/MempoolWatcher';
import { TipFollower } from './services/indexer/TipFollower';
import { AddressClusterJob } from './services/jobs/AddressClusterJob';
import { BoincStatsImportJob } from './services/jobs/BoincStatsImportJob';
import { PollWeightAggregator } from './services/jobs/PollWeightAggregator';
import { WealthSnapshotJob } from './services/jobs/WealthSnapshotJob';
import { NetworkStatsPoller } from './services/network/NetworkStatsPoller';
import { MeiliIndexer } from './services/search/MeiliIndexer';
// Retired during the ClickHouse migration:
//   - FeePercentileJob → replaced by `fee_quantiles_1h` MV.
//   - LegacyContractsBackfiller / PollRescanner → redundant. BlockWriter
//     now extracts polls / beacons / superblocks inline from each
//     block's contracts as it indexes.
//   - MeiliReindexJob → MeiliIndexer alone consumes the queue; the
//     dirty-sentinel / forced-rebuild flow can come back if needed.
import { adminWatcherTick } from './services/admin/adminWatcher';
import { EventsService } from './services/sse/EventsService';
import { startApi } from './api';

// If a prior run died on a fatal DuckDB index corruption it set this flag
// before exiting. The dangling ART-index entries are persisted on disk, so
// resuming the indexer now would just re-fatal on the next range delete.
// Rebuild every non-unique secondary index (DROP + CREATE rebuilds it clean
// from the table rows) before any tick runs, then clear the flag. We rebuild
// all of them, not just the chain-height tables, so a fatal originating in
// any indexed table (e.g. the network_snapshots prune) is healed too — it's
// a one-time cost paid only after an actual corruption event. No-op on a
// healthy boot. Indexer-role only — the api role never writes, so it can't
// fatal.
async function repairIndexesIfNeeded(): Promise<void> {
  if (!(await isIndexRebuildNeeded())) return;
  log.warn('Index-rebuild flag set by a prior fatal DB error; rebuilding secondary indexes before resuming');
  const rebuilt = await rebuildSecondaryIndexes();
  await clearIndexRebuildNeeded();
  log.info(`Rebuilt ${rebuilt.length} secondary index(es): ${rebuilt.join(', ') || '(none)'}`);
}

async function bootIndexer(): Promise<void> {
  log.info(`Booting indexer (network=${config.NETWORK})`);
  await waitForRpc();
  await repairIndexesIfNeeded();

  // Mirror every locally emitted event onto Redis pub/sub so api
  // replicas can fan it out to their SSE clients. Skip in role=all —
  // the local EventEmitter already delivers to the SSE service in the
  // same process, so going through Redis would create an echo loop:
  // publish → Redis echoes back → subscribeFromRedis re-emits locally
  // → listener republishes → infinite loop, with values arriving out
  // of order on the wire (visible in the UI as a flickering tip height).
  if (config.ROLE !== 'all') {
    publishToRedis();
  }

  const reorg = new ChainReorgHandler();
  const tipFollower = new TipFollower(reorg);
  const networkStats = new NetworkStatsPoller();

  // Backfiller is invoked on a schedule (single-flight) so it gets
  // re-armed if cursor.status ever flips back to `backfilling` — which
  // TipFollower does when it detects a large lag. When the backfiller
  // has nothing to do (status === 'live'), `run()` returns true
  // immediately.
  const backfiller = new HistoricalBackfiller();
  schedule(60_000, () => backfiller.run().then(() => undefined), 'HistoricalBackfiller');

  schedule(config.TIP_POLL_INTERVAL_MS, () => tipFollower.tick(), 'TipFollower');
  schedule(config.REORG_SAFETY_SWEEP_INTERVAL_MS, () => reorg.safetySweep(), 'ReorgSafetySweep');
  // Mempool watching is opt-out. When disabled (dev/replica boxes
  // that get switched on and off), mempool_txs / mempool_snapshots /
  // mrc_requests stay frozen at whatever was last persisted — the
  // wallet keeps churning while we're off, and re-engaging mid-stream
  // would store an out-of-sync view. Prod always-on leaves it true.
  if (config.MEMPOOL_WATCHER_ENABLED) {
    const mempool = new MempoolWatcher();
    schedule(config.MEMPOOL_POLL_INTERVAL_MS, () => mempool.tick(), 'MempoolWatcher');
  } else {
    log.info('MempoolWatcher disabled (MEMPOOL_WATCHER_ENABLED=false)');
  }
  schedule(config.NETWORK_STATS_INTERVAL_MS, () => networkStats.tick(), 'NetworkStats');

  // Daily wealth snapshot — Gini, top-N share, hodler windows. The job
  // is idempotent per UTC-day bucket, so a 1h cadence just means the
  // first tick after midnight writes the day's row.
  const wealth = new WealthSnapshotJob();
  schedule(60 * 60_000, () => wealth.tick(), 'WealthSnapshot');

  // Vote weights once polls close. Single-flight; caps at 5 polls per
  // tick so a backlog doesn't monopolise the scheduler.
  const pollWeights = new PollWeightAggregator();
  schedule(15 * 60_000, () => pollWeights.tick(), 'PollWeightAggregator');

  // Off-chain BOINC user-stats import. Resolves CPIDs to display
  // names by streaming each whitelisted project's `user.gz` export
  // and upserting into `project_users`. Idempotent per ~20h via
  // `project_user_imports.last_success_at`, so a 1h schedule means
  // each project pulls once per day at most, retrying on failure.
  const boinc = new BoincStatsImportJob();
  schedule(60 * 60_000, () => boinc.tick(), 'BoincStatsImport');

  // Common-input-ownership address clustering. Ticks hourly but the
  // job self-gates on a Redis last-run (~12h), so almost every tick
  // is an instant no-op; the gate persists across restarts so a
  // hot-reload never re-triggers the heavy full rebuild.
  const cluster = new AddressClusterJob();
  schedule(60 * 60_000, () => cluster.tick(), 'AddressCluster');

  // In-process admin-task executor. DuckDB is single-writer, so wipe /
  // boinc-fetch / rebuild-wallets can't run as separate processes while
  // this one holds the file — they're enqueued (npm run admin -- …) and
  // executed here on our own connection. Single-flight via schedule(), so
  // a long wipe never overlaps its own next poll. 15s idle cadence: the
  // operator isn't latency-sensitive and the requester waits up to 30s
  // for a claim, so this stays well inside that window while idle-polling
  // Redis only ~4×/min on a deliberately resource-tight box.
  schedule(15_000, () => adminWatcherTick(), 'AdminWatcher');

  // Meili drainer — long-running consumer over the meili:queue Redis
  // stream that BlockWriter.runPostCommit feeds. Doesn't fit setInterval;
  // it idles cheaply via XREAD BLOCK when the queue is empty.
  const meili = new MeiliIndexer();
  meili.run().catch((err) => log.error('MeiliIndexer crashed', err));
}

async function bootApi(): Promise<void> {
  log.info(`Booting api (network=${config.NETWORK})`);
  // Start the SSE service early so it's wired up to the emitter before
  // any cross-process events arrive.
  EventsService.getInstance();
  // Subscribe to Redis only when we're a separate api replica that
  // can't see the indexer's local emitter. In role=all the indexer is
  // in the same process — local emit reaches the SSE service directly.
  if (config.ROLE !== 'all') {
    await subscribeFromRedis();
  }
  const server = startApi();
  if (server) {
    // Stop accepting connections on shutdown so the process can exit
    // cleanly instead of being SIGKILLed with sockets still open.
    onShutdown(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  }
}

async function main(): Promise<void> {
  if (config.isTesting) {
    log.info('NODE_ENV=testing — skipping background workers');
    return;
  }

  // Graceful shutdown: catch SIGTERM/SIGINT, drain in-flight ticks, then
  // tear down in dependency order — DuckDB first (CHECKPOINT flushes the
  // WAL so the next open is clean), Redis last. Registered before booting
  // so a signal during startup is still handled.
  installSignalHandlers();
  onShutdown(closeDb);
  onShutdown(closeRedis);

  if (config.ROLE === 'api' || config.ROLE === 'all') {
    await bootApi();
  }
  if (config.ROLE === 'indexer' || config.ROLE === 'all') {
    await bootIndexer();
  }
}

main().catch((err) => {
  log.error('Fatal boot error', err);
  process.exit(1);
});
