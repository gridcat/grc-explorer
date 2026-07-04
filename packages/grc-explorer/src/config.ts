import nconf from 'nconf';
import path from 'path';
import packageJson from '../package.json';

export type Network = 'mainnet' | 'testnet';
export type Role = 'api' | 'indexer' | 'all';

interface Config {
  // MariaDB — source of truth for chain data (see lib/db.ts). A single
  // mysql://user:pass@host:3306/db URL plus reader/writer pool sizes kept
  // deliberately small for the 1–2 GB prod slice.
  DATABASE_URL: string;
  DB_POOL_WRITE: number;
  DB_POOL_READ: number;
  // Cloudflare cache purge on reorg. Optional — when both are set, a chain
  // reorg purges the edge cache so stale tip-ward pages don't survive the
  // rollback. Unset → no-op (e.g. dev / no CDN in front).
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  // Which Gridcoin network this stack indexes. Carried in API responses
  // (`meta.network`) and exported to the frontend via NEXT_PUBLIC_NETWORK
  // so the UI can flip palette and refuse cross-network rendering.
  NETWORK: Network;
  // Process role. `api` runs Express + SSE only; `indexer` runs the
  // block-walk / mempool / Meili workers; `all` runs both in one process
  // (default for dev).
  ROLE: Role;
  // Wallet daemon JSON-RPC connection. RPC_USER/PASSWORD are optional
  // because the dev wallet runs without auth; in prod they come from env.
  GRC_RPC_USER?: string;
  GRC_RPC_PASSWORD?: string;
  GRC_RPC_HOST: string;
  GRC_RPC_PORT: number;
  // Redis — used for the indexer cursor mirror, single-flight locks,
  // pub/sub fanout of SSE events across api replicas, and the meili
  // queue stream.
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PREFIX: string;
  // Meilisearch sidecar.
  MEILI_HOST: string;
  MEILI_API_KEY?: string;
  MEILI_INDEX_PREFIX: string;
  // Convenience mirrors of NODE_ENV. isTesting disables background
  // jobs so unit tests don't fire RPC calls or mutate the DB from timers.
  isProduction: boolean;
  isTesting: boolean;
  // HTTP listener.
  PORT: number;
  // 1 GRC = 1e8 halford. We always store amounts as BigInt halford.
  HALFORD: number;
  // Indexer cadence + sizing.
  TIP_POLL_INTERVAL_MS: number;
  MEMPOOL_POLL_INTERVAL_MS: number;
  // Set to `false` to stop polling the daemon's mempool entirely.
  // Useful on dev/replica boxes that get switched on and off — once
  // the indexer is offline the wallet's mempool keeps churning, so
  // entered/exited transitions are lost and the persisted state
  // drifts from reality. Prod (always-on) should leave this `true`.
  MEMPOOL_WATCHER_ENABLED: boolean;
  REORG_SAFETY_SWEEP_INTERVAL_MS: number;
  NETWORK_STATS_INTERVAL_MS: number;
  // PollRescanner cadence. The job is single-flight via `schedule()` —
  // the first tick walks the entire chain (hours on a fresh sync) and
  // any re-fires during that window are skipped. Once the cursor
  // catches tip, every tick is just a few RPCs to confirm "no new
  // blocks since last run". 1h is plenty.
  POLL_RESCAN_INTERVAL_MS: number;
  BACKFILL_BATCH_SIZE: number;
  // Sequential mode. When true, HistoricalBackfiller bypasses the
  // entire pipeline (semaphore, AIMD, fetch buffer, txBatchSize
  // accumulator) and walks the chain one block at a time: fetch
  // single block, parse, apply, advance cursor, repeat. Slow but
  // boring — no parallelism, no out-of-order arrivals, no batch
  // accumulation that can be lost on a single-call failure. Each
  // committed block is durable before the next call starts. Use
  // when the daemon is too stressed for the parallel pipeline.
  BACKFILL_SEQUENTIAL: boolean;
  // Maximum (and starting) heavy-lane concurrency. Adaptive
  // backpressure halves the *effective* concurrency under daemon
  // stress and ramps it back toward this ceiling on sustained
  // success — see `services/indexer/AdaptiveLimits.ts`. Ignored
  // entirely when BACKFILL_SEQUENTIAL=true.
  BACKFILL_CONCURRENCY: number;
  // Floor for adaptive concurrency. At least one batch is always
  // permitted under stress so backfill makes some forward progress
  // even when the daemon is having a rough time.
  BACKFILL_CONCURRENCY_MIN: number;
  // Cooldown applied after each completed `getblocksbatch` before the
  // next one is issued. Concurrency caps parallelism but not duty
  // cycle — with two batches always in flight the daemon never goes
  // idle, so other clients of the shared wallet (notably stamp's
  // `getbalance`) can't acquire `cs_main`. A non-zero delay here
  // forces explicit gaps the wallet's other callers can slip into.
  // Default 0 (no cooldown). Tune up when sharing the daemon.
  BACKFILL_BATCH_DELAY_MS: number;
  // Maximum (and starting) blocks per `getblocksbatch` RPC. Each
  // span is one round-trip + one daemon-side serialize, so bigger
  // spans amortize RTT but inflate response payload and the daemon's
  // cs_main hold time per call. Adaptive backpressure halves this
  // under stress and ramps back toward the ceiling on success.
  BACKFILL_FETCH_SPAN: number;
  // Floor for adaptive fetch span. 1 = single block per call when
  // the daemon is most stressed.
  BACKFILL_FETCH_SPAN_MIN: number;
  // Successful heavy batches required before adaptive limits bump
  // either dimension by one step. Higher = more conservative ramp,
  // less oscillation.
  BACKFILL_ADAPTIVE_RAMP_THRESHOLD: number;
  // Stress-signal debounce. A burst of failures inside this window
  // counts as one halving event, not five — prevents AIMD from
  // collapsing straight to the floor on a single stress incident.
  BACKFILL_ADAPTIVE_STRESS_DEBOUNCE_MS: number;
  // Quiet period after a stress event during which all heavy-lane
  // calls are refused outright, giving the daemon's RPC queue room
  // to drain whatever it's already working on. We can't abort the
  // daemon's in-flight work from the client side; the only honest
  // backpressure is "stop pestering it for a while". Longer than
  // the breaker cooldown because daemon drain is the goal here,
  // not just our local retry pause.
  BACKFILL_ADAPTIVE_STRESS_QUIET_MS: number;
  // How many parsed blocks to fold into one MySQL transaction during
  // backfill. Larger values amortize commit/fsync overhead but lengthen
  // the time the API path waits if it tries to read while the batch
  // is open. Default chosen so a typical batch finishes in well under
  // the 60s tx timeout even on slow Docker filesystems.
  BACKFILL_TX_BATCH_SIZE: number;
  // Confirmations beyond which the api treats a tx as "settled". Below
  // this the response includes a soft flag so the UI can render
  // "unconfirmed (N/6)".
  SAFE_CONFIRMATIONS: number;
  // Reorg guard. Walk-backs deeper than this abort and require operator
  // intervention rather than silently rewriting half the chain.
  MAX_REORG_DEPTH: number;
  // RPC resilience — same shape as grcpay's breaker. Set threshold to 0
  // to disable.
  RPC_TIMEOUT_MS: number;
  RPC_BREAKER_THRESHOLD: number;
  RPC_BREAKER_COOLDOWN_MS: number;
  // Number of reverse-proxy hops Express trusts when resolving the
  // client IP for rate limiting. 1 matches the standard nginx-in-front
  // deployment.
  TRUST_PROXY_HOPS: number;
  // Per-IP rate limits (60s window). Reads loose because dashboards
  // poll, search tighter because Meili calls are heavier, SSE subscribe
  // tightest because each new subscription mutates server-side state.
  RATE_LIMIT_READS_PER_MIN: number;
  RATE_LIMIT_SEARCH_PER_MIN: number;
  RATE_LIMIT_SSE_SUBSCRIBE_PER_MIN: number;
  // Global RPS ceiling across all IPs combined. Sheds distributed
  // floods that wouldn't trip any single IP's per-minute budget.
  RATE_LIMIT_GLOBAL_RPS: number;
}

const checkConfig = (settings: string[]): void => {
  settings.forEach((setting) => {
    if (nconf.get(setting) === undefined || nconf.get(setting) === null || nconf.get(setting) === '') {
      throw new Error(`You must set ${setting} as an environment variable or in config.json!`);
    }
  });
};

nconf
  .argv()
  .env({
    whitelist: [
      'DATABASE_URL',
      'DB_POOL_WRITE',
      'DB_POOL_READ',
      'CF_API_TOKEN',
      'CF_ZONE_ID',
      'NETWORK',
      'ROLE',
      'GRC_RPC_USER',
      'GRC_RPC_PASSWORD',
      'GRC_RPC_HOST',
      'GRC_RPC_PORT',
      'REDIS_HOST',
      'REDIS_PORT',
      'REDIS_PREFIX',
      'MEILI_HOST',
      'MEILI_API_KEY',
      'MEILI_INDEX_PREFIX',
      'PORT',
      'TIP_POLL_INTERVAL_MS',
      'MEMPOOL_POLL_INTERVAL_MS',
      'MEMPOOL_WATCHER_ENABLED',
      'REORG_SAFETY_SWEEP_INTERVAL_MS',
      'NETWORK_STATS_INTERVAL_MS',
      'POLL_RESCAN_INTERVAL_MS',
      'BACKFILL_BATCH_SIZE',
      'BACKFILL_SEQUENTIAL',
      'BACKFILL_CONCURRENCY',
      'BACKFILL_CONCURRENCY_MIN',
      'BACKFILL_BATCH_DELAY_MS',
      'BACKFILL_FETCH_SPAN_MIN',
      'BACKFILL_ADAPTIVE_RAMP_THRESHOLD',
      'BACKFILL_ADAPTIVE_STRESS_DEBOUNCE_MS',
      'BACKFILL_ADAPTIVE_STRESS_QUIET_MS',
      'BACKFILL_FETCH_SPAN',
      'BACKFILL_TX_BATCH_SIZE',
      'SAFE_CONFIRMATIONS',
      'MAX_REORG_DEPTH',
      'RPC_TIMEOUT_MS',
      'RPC_BREAKER_THRESHOLD',
      'RPC_BREAKER_COOLDOWN_MS',
      'TRUST_PROXY_HOPS',
      'RATE_LIMIT_READS_PER_MIN',
      'RATE_LIMIT_SEARCH_PER_MIN',
      'RATE_LIMIT_SSE_SUBSCRIBE_PER_MIN',
      'RATE_LIMIT_GLOBAL_RPS',
    ],
    parseValues: true,
  })
  .file({
    file: path.join(__dirname, '../config.json'),
  })
  .defaults({
    NETWORK: 'testnet',
    ROLE: 'all',
    // Dedicated explorer MariaDB (its own instance in the explorer compose,
    // not the shared family grc_mysql — origin-IP isolation). Pools stay
    // small: on the 1–2 GB prod slice the box can't afford a wide pool, and
    // the reader/writer split bounds each side independently.
    //
    // DB_POOL_WRITE=1 — a SINGLE writer connection, matching DuckDB's old
    // single-writer model. The write path fans ~20 per-table inserts out
    // via Promise.all and the backfiller pipelines batches concurrently; on
    // a multi-connection writer pool those become concurrent InnoDB
    // transactions that lock the same tables' secondary-index gaps in
    // different orders and deadlock (errno 1213). One writer connection
    // serialises all of it — the fetch side still parallelises, which is
    // where backfill throughput actually comes from.
    DATABASE_URL: 'mysql://admin:IamAdmin@mysql:3306/grc_explorer',
    DB_POOL_WRITE: 1,
    DB_POOL_READ: 6,
    REDIS_HOST: 'redis',
    REDIS_PORT: 6379,
    REDIS_PREFIX: 'grc-explorer:testnet',
    MEILI_HOST: 'http://meili:7700',
    MEILI_INDEX_PREFIX: 'grc_explorer_testnet',
    isTesting: process.env.NODE_ENV === 'testing',
    isProduction: process.env.NODE_ENV === 'production',
    PORT: packageJson.port,
    HALFORD: 100_000_000,
    TIP_POLL_INTERVAL_MS: 8_000,
    MEMPOOL_POLL_INTERVAL_MS: 3_000,
    MEMPOOL_WATCHER_ENABLED: true,
    REORG_SAFETY_SWEEP_INTERVAL_MS: 60_000,
    NETWORK_STATS_INTERVAL_MS: 15_000,
    POLL_RESCAN_INTERVAL_MS: 60 * 60_000,
    // Defaults tuned for "fresh testnet/mainnet sync that needs to walk
    // millions of blocks" without saturating the wallet daemon.
    //  - BACKFILL_CONCURRENCY = parallel `getblock` RPCs in flight.
    //    8 leaves headroom for the other clients of the same daemon
    //    (MempoolWatcher, NetworkStatsPoller, TipFollower-side calls,
    //    legacy backfiller). Pushing to 16 saturated the daemon's RPC
    //    queue and tripped our circuit breaker on every other caller.
    //    Bump higher only if you've also bumped `-rpcthreads` /
    //    `-rpcworkqueue` on the daemon.
    //  - BACKFILL_TX_BATCH_SIZE = blocks committed per Prisma tx.
    //    1 = one MySQL fsync per block, mirroring TipFollower's live
    //    cadence. We picked the bigger value originally for raw
    //    throughput (one fsync per N blocks dominates Docker overlay-fs
    //    backfill cost), but the visible side effect — multi-second
    //    "pauses" between commits and SSE events arriving in big bursts
    //    of N — felt unreliable in the dashboard. Per-block commits
    //    cost ~5× the wall-clock for backfill but produce a steady
    //    one-event-per-block firehose that exactly mirrors live tip
    //    behaviour. Bump back to 50–500 if you ever need pure speed
    //    over visual smoothness; deferred post-commit means the SSE/
    //    Meili work doesn't sit on the critical path either way.
    //  - BACKFILL_BATCH_SIZE = how many heights one `processRange`
    //    pumps through the fetcher pipeline. Bigger = longer in-flight
    //    queue but no commit-cost change.
    BACKFILL_BATCH_SIZE: 1000,
    BACKFILL_SEQUENTIAL: false,
    // Climbed from 8 → 16 → 32 alongside `rpcthreads=64` on the
    // wallet daemon (see grc-wallet/entrypoint.sh). The 2:1 ratio
    // (concurrency × 2 ≈ rpcthreads) leaves room for the other RPC
    // clients (MempoolWatcher, NetworkStatsPoller, TipFollower,
    // legacy backfiller, PollRescanner). Past this point gridcoin-
    // researchd hits internal lock contention rather than thread-
    // pool saturation; doubling further didn't change throughput
    // in testing.
    //
    // Backed off 32 → 16 (2026-04-30): with 32 in-flight `getblock`s,
    // gridcoinresearchd holds `cs_main` long enough that
    // `getrawmempool` from MempoolWatcher times out past 30 s, trips
    // the shared RPC breaker, and stalls the indexer.
    //
    // Backed off 16 → 8 (2026-05-01): even at 16, when
    // LegacyContractsBackfiller's `beaconreport` runs against a
    // backfiller already pumping 16 `getblock`s, cs_main stays held
    // long enough that the daemon stops processing P2P blocks for
    // 10+ minutes and every other RPC (including our own
    // `getblockchaininfo` health probe) hits the 60 s timeout. 8
    // halves the in-flight getblock pressure so heavy callers like
    // beaconreport can land between batches.
    BACKFILL_CONCURRENCY: 8,
    BACKFILL_CONCURRENCY_MIN: 1,
    BACKFILL_BATCH_DELAY_MS: 0,
    BACKFILL_FETCH_SPAN_MIN: 1,
    BACKFILL_ADAPTIVE_RAMP_THRESHOLD: 10,
    BACKFILL_ADAPTIVE_STRESS_DEBOUNCE_MS: 30_000,
    BACKFILL_ADAPTIVE_STRESS_QUIET_MS: 60_000,
    // 25 blocks per `getblocksbatch` RPC. With BACKFILL_CONCURRENCY=8
    // that's 200 blocks pulled per 8-deep RPC pool depth — same daemon
    // pressure as the per-block fetcher used to apply, ~25× fewer RTTs.
    // Daemon caps at 1000; raise cautiously, very large spans stretch
    // payload to multi-MB on dense modern heights and increase the
    // wallclock window the daemon holds `cs_main` to serialize the
    // response.
    BACKFILL_FETCH_SPAN: 25,
    // 50 blocks per MySQL transaction. The bulk-batch write path
    // (`applyBlockBatchInTx`) fires ~15 Prisma round-trips per batch
    // regardless of size, so doubling the batch roughly halves the
    // per-block round-trip cost. Risk: bigger batches mean a deadlock
    // rolls back more work. Cost: SSE events arrive in bursts of N
    // (the home dashboard's RAF-coalescing absorbs that).
    BACKFILL_TX_BATCH_SIZE: 50,
    SAFE_CONFIRMATIONS: 6,
    MAX_REORG_DEPTH: 100,
    // Bumped 30 s → 60 s (2026-04-30): under heavy backfill, getblock
    // batches hold cs_main for tens of seconds during chain-tip
    // processing or reorgs; 30 s timed out otherwise-healthy
    // `getrawmempool` / `getblockhash` calls and tripped the breaker.
    RPC_TIMEOUT_MS: 60_000,
    RPC_BREAKER_THRESHOLD: 5,
    RPC_BREAKER_COOLDOWN_MS: 30_000,
    TRUST_PROXY_HOPS: 1,
    RATE_LIMIT_READS_PER_MIN: 1800,
    RATE_LIMIT_SEARCH_PER_MIN: 300,
    RATE_LIMIT_SSE_SUBSCRIBE_PER_MIN: 60,
    RATE_LIMIT_GLOBAL_RPS: 100,
  });

checkConfig([
  'DATABASE_URL',
  'NETWORK',
  'GRC_RPC_HOST',
  'GRC_RPC_PORT',
  'PORT',
]);

const network = nconf.get('NETWORK');
if (network !== 'mainnet' && network !== 'testnet') {
  throw new Error(`NETWORK must be "mainnet" or "testnet" (got "${network}")`);
}

const role = nconf.get('ROLE');
if (role !== 'api' && role !== 'indexer' && role !== 'all') {
  throw new Error(`ROLE must be "api" | "indexer" | "all" (got "${role}")`);
}

export const config = Object.freeze(nconf.get()) as Config;
