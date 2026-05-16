import { EventEmitter } from 'events';

/**
 * Typed bus for in-process events. Cross-process delivery happens via
 * Redis pub/sub (see lib/fanout.ts) — anything emitted here is also
 * mirrored onto the matching Redis channel so api replicas pick it up.
 *
 * Topics use dotted namespacing. `address.<addr>.balance` and
 * `cpid.<cpid>.magnitude` carry their key in the topic name so SSE
 * clients can filter by exact match without payload inspection.
 */

export type ExplorerEvent =
  | { topic: 'block.new'; payload: BlockNewPayload }
  | { topic: 'block.tip'; payload: { tip_height: number; tip_hash: string } }
  | { topic: 'superblock.new'; payload: SuperblockNewPayload }
  | { topic: 'chain.reorg'; payload: ReorgPayload }
  | { topic: 'mempool.entered'; payload: MempoolEntryPayload }
  | { topic: 'mempool.exited'; payload: { tx_id: string; reason: 'confirmed' | 'evicted' } }
  | { topic: 'mempool.tick'; payload: { count: number; total_fees: string; total_size: number } }
  | { topic: 'mempool.fee_histogram'; payload: { buckets: Array<{ fee_per_kb: number; count: number }> } }
  | { topic: `address.${string}.balance`; payload: AddressBalancePayload }
  | { topic: `address.${string}.tx`; payload: { address: string; tx_id: string; height: number; delta: string } }
  | { topic: `cpid.${string}.magnitude`; payload: { cpid: string; magnitude: number; superblock_height: number } }
  | { topic: 'network.stats'; payload: NetworkStatsPayload }
  | { topic: 'metrics.tick'; payload: MetricsTickPayload }
  | { topic: 'metrics.daily'; payload: MetricsDailyPayload }
  | { topic: 'backfill.progress'; payload: { height: number; tip: number; pct: number } }
  | { topic: 'project.added'; payload: ProjectContractPayload }
  | { topic: 'project.removed'; payload: ProjectContractPayload }
  | { topic: 'wealth.snapshot'; payload: WealthSnapshotPayload }
  | { topic: 'beacon.update'; payload: BeaconUpdatePayload }
  | { topic: 'sidestake.update'; payload: SidestakeUpdatePayload }
  | { topic: 'sidestake.payout'; payload: SidestakePayoutPayload };

export interface ProjectContractPayload {
  name: string;
  base_url: string;
  tx_id: string;
  block_height: number;
  time: number;
}

export interface BlockNewPayload {
  height: number;
  hash: string;
  prev_hash: string;
  time: number;
  tx_count: number;
  is_pos: boolean;
  is_superblock: boolean;
  miner_address: string | null;
  staker_cpid: string | null;
}

// Fired in addition to `block.new` when an indexed block is a
// superblock. The two are siblings, not a replacement: dashboards that
// only care about per-superblock data (magnitude leaderboard, top
// movers) subscribe to this and skip the ~1440 block.new events
// between superblocks where their endpoint response is byte-identical.
export interface SuperblockNewPayload {
  height: number;
  hash: string;
  time: number;
}

export interface ReorgPayload {
  fork_height: number;
  depth: number;
  abandoned_hashes: string[];
  new_hashes: string[];
}

export interface MempoolEntryPayload {
  tx_id: string;
  fee: string;
  size: number;
  vin_count: number;
  vout_count: number;
  first_seen: number;
}

export interface AddressBalancePayload {
  address: string;
  balance: string;
  delta: string;
  height: number;
  tx_id: string;
}

export interface NetworkStatsPayload {
  /** Daemon's chain tip. Null when the RPC has never succeeded and no
   *  prior cache exists — must NOT be faked from the latest indexed
   *  block, that makes the UI falsely report "caught up". */
  tip_height: number | null;
  tip_hash: string;
  difficulty: string;
  peer_count: number;
  mempool_size: number;
  // Older Gridcoin builds packed these as integers; current builds
  // return human strings like "v5.5.0.1-unk". Accept either.
  net_version: number | string;
  rpc_version: number | string;
}

export interface MetricsTickPayload {
  granularity: '5min' | '1h';
  bucket_ts: number;
  tx_count: number;
  value_moved: string;
  fee_total: string;
  block_count: number;
  research_subsidy_total: string;
  block_subsidy_total: string;
}

// Fired by WealthSnapshotJob after each batch write. Payload carries
// the latest bucket the batch produced, so dashboards listening for
// "the wealth chart has new data" can refresh exactly when there's
// something new to render (instead of polling at block cadence).
export interface WealthSnapshotPayload {
  bucket_ts: number;
}

// Fired by BlockWriter when a beacon contract lands in an indexed
// block. Powers beacon-shape dashboards (flux, survival) so they
// stop refreshing on every block.new and instead refresh only when
// the underlying beacon set changes. Action enum matches the on-chain
// contract action: 'advertise' = new/renewed beacon ('A'), 'revoke'
// = explicit removal ('D'). Passive 180-day MAX_AGE expiry is NOT an
// on-chain event and produces no SSE; consumers that care about it
// must keep a slow safety poll to catch the window drift.
// Emitted once per block that carries any beacon contract; per-contract
// granularity isn't needed by today's consumers.
export interface BeaconUpdatePayload {
  height: number;
  time: number;
  action: 'advertise' | 'revoke' | 'mixed';
}

// Fired by BlockWriter when a mandatory-sidestake contract lands —
// the protocol-driven registry of MSS destinations changed (an
// address was added, allocation was updated, or an entry was
// deleted). MSS-aware dashboards refresh on this instead of
// block.new so they only fetch when the registry actually moves.
export interface SidestakeUpdatePayload {
  address: string;
  action: 'A' | 'D';
  status: 'MANDATORY' | 'DELETED';
  allocation_pct: number;
  description: string;
  height: number;
  time: number;
}

// Fired by BlockWriter for each V13+ PoS block whose coinstake had
// any extra outputs (vout idx >= 2). One event per block, summarising
// the recipients. MSS-aware dashboards refresh on this to bump the
// per-recipient running totals + 24h counts without rescanning the
// whole block range. `count` is the number of extras on the block;
// `total` is the summed payout amount across all extras in halford.
export interface SidestakePayoutPayload {
  height: number;
  time: number;
  count: number;
  total: string; // halford as string for JSON safety
}

export interface MetricsDailyPayload {
  research_subsidy_24h: string;
  block_subsidy_24h: string;
  active_beacons: number;
  new_beacons_24h: number;
  expired_beacons_24h: number;
  researcher_share_pct: number;
  top_cpids: Array<{ cpid: string; magnitude: number; subsidy: string }>;
}

class TypedEmitter extends EventEmitter {
  publish<E extends ExplorerEvent>(event: E): void {
    this.emit(event.topic, event.payload);
    // Wildcard channels — `address.*` listeners get every address.* event
    // tagged with the original topic, so SSE filtering can match by prefix.
    const dot = event.topic.indexOf('.');
    if (dot > 0) {
      this.emit(`${event.topic.slice(0, dot)}.*`, event);
    }
  }
}

export const events = new TypedEmitter();

// Don't crash the process if a listener forgets to attach.
events.setMaxListeners(0);

// Single source of truth for the static topics SSE + cross-process
// fanout need to hook by name. Per-key channels (address.<addr>,
// cpid.<cpid>) are handled via the `<root>.*` wildcards in `publish`
// above and so don't appear here. Adding a new ExplorerEvent topic
// requires adding it here too; the cast keeps the array typed
// against the discriminated-union so a typo is a TS error.
export const STATIC_TOPICS: ReadonlyArray<ExplorerEvent['topic']> = [
  'block.new',
  'block.tip',
  'superblock.new',
  'chain.reorg',
  'mempool.entered',
  'mempool.exited',
  'mempool.tick',
  'mempool.fee_histogram',
  'network.stats',
  'metrics.tick',
  'metrics.daily',
  'backfill.progress',
  'project.added',
  'project.removed',
  'wealth.snapshot',
  'beacon.update',
  'sidestake.update',
  'sidestake.payout',
];
